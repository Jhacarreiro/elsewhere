# Decision Multiverse — research roadmap

**Status:** Phase 1 is complete: steps 1 and 2 are documented, steps 3 to 5 have a working prototype ([decision map](DECISION_MAP.md)) demonstrated on one real run in step 6, and the map can be written at the end of each Development Cycle run when the operator configures it as the run-end command, as on the owner's machine. Phase 2 is in progress. Phases 3 and 4 are not started, and no research results are established. **Home:** Elsewhere research documentation, not a claim about the existing Development Cycle product.

## Vision

Solutions, not software output, are the unit of value. AI agents execute; humans contribute context, imagination, taste, choices and accountability. A development run is one observed trajectory through a space of possible solutions. We want to expose its consequential decisions, understand alternatives, and eventually revisit a fork and compare real outcomes.

**No predetermined branches.** Neither the number of alternatives nor their labels/categories are fixed. They must arise from the actual decision, available context, feasibility and meaningful trade-offs. Zero alternatives is legitimate. Alternative branches are suggestions until executed and independently validated.

## Phase 0 — linear baseline (prerequisite)

Every later comparison is against linear execution, so the linear cycle must first finish reliably on its own. The criterion is the Development Cycle [reliability baseline](https://github.com/Jhacarreiro/openclaw-development-cycle/blob/main/docs/reliability-baseline.md), summarized here:

- a fixed, meaningful real task chosen by the user, with behavioral acceptance checks written before any run; the task may stay private, and synthetic fixtures are only for deterministic tests;
- repeated runs through the normal `development_cycle` flow reach a recorded `go`, `revise` or `stop` without an infrastructure-classified failure;
- each run's evidence is complete: approved plan, delivery, mechanical validation and final decision;
- duration, cost and interventions are recorded per run, so they can serve as the comparison baseline.

**Status (2026-10-26):** the owner accepted the current baseline, round 8kv859, as sufficient to proceed. That run reached a recorded decision on its own, but its corrections failed and its delivery was partial, and the reliability baseline's repeated-run criterion is not met. Comparisons in later phases must state this limit.

These runs are also the first evaluation data for Phase 1. Runs from unrelated projects are not used as evidence. Because the baseline task is private, Phase 1 reads its runs locally and publishes only sanitized examples.

## Phase 1 — decision provenance and post-run map (implementation target)

1. Inspect existing event, plan, run, adapter and validation artifacts. Document provenance and gaps before changing code. Done: [decision provenance inventory](DECISION_PROVENANCE.md). Artifacts that already carry observed decisions include `intervention.json` with its recorded answer, `final_validation_response.md`, normalized plan versions and council synthesis output.
2. Proposed in [decision record v0](DECISION_RECORD.md) and [its JSON Schema](../schemas/decision-record.v0.schema.json). Define a portable, additive decision record that any implementation adapter may emit optionally, so the map does not depend on one runner (Octopus can be the first producer): stable ID, run/phase, time, source artifact pointer, what was decided, observable evidence, chosen option, locally relevant unchosen alternatives, concise trade-offs, uncertainty, and classification (`observed` / `agent-stated` / `post-hoc-inferred`). Never fabricate an agent's past reasoning.
3. Extract consequential decisions from an existing finished run **read-only**, using observed evidence. Avoid logging every token or arbitrary implementation step. Include explicit 'unknown' when alternatives or rationale cannot be reconstructed. Prototype: [`decision-map/extract.mjs`](../decision-map/extract.mjs).
4. Produce a small portable JSON schema and readable visual map (Mermaid or static HTML). Progressive disclosure: one-line summaries first; show source, evidence, pros/cons and uncertainty on selection. Distinguish chosen/executed/validated, unexecuted hypotheses, and unknowns. Prototype: [`decision-map/render.mjs`](../decision-map/render.mjs), static HTML.
5. Support a configurable relevance filter based on impact, reversibility, cost and uncertainty, without hard-coded option types or branch counts. Preserve the original record and provenance. Prototype: [`decision-map/filter.mjs`](../decision-map/filter.mjs).
6. Demonstrate with one sanitized, realistic example run. Do not read production state into the public repository or embed deployment-specific values. The only exception is the reviewed example described in the [publication checklist](../PUBLICATION.md): [baseline round 8kv859](../examples/baseline-round-8kv859/README.md), the decision records of one finished run, published with the owner's consent. It is a failure-path example: its corrections failed and its delivery was partial.
7. Write the map at the end of each run, where the operator opts in. The Development Cycle runs an optional, operator-configured command when a run closes, and [`decision-map/map-run.mjs`](../decision-map/map-run.mjs) writes `decision-map/decisions.jsonl` and `map.html` into the run directory. This runs only on the operator's machine, and nothing from it reaches this repository.

**Out of scope for Phase 1:** live branching, automatic replay, unconstrained parallel execution, predicted outcomes stated as facts, hidden chain-of-thought extraction, production-runtime changes, new agent runs.

## Acceptance checks

- Human usefulness is judged against a stated criterion, for example the map changed a decision or located a failure cause faster than reading the run artifacts.

- An actual completed run can be summarized without changing its execution or artifacts.
- Each displayed claim is linked to evidence or marked as inference/unknown.
- A decision may have any natural number of meaningful alternatives, including zero; no three-option template.
- The map can distinguish **observed outcome** from **hypothesized consequence** at a glance.
- Missing telemetry never becomes invented rationale.
- Generated public examples are portable and pass the repository's public-sanitization audit.
- No tautological checks, change-detector tests or regression tests without a genuine behavior gap.

## Phase 2 — contextual alternatives (in progress)

Goal: for a consequential decision, describe what else could reasonably have been done, grounded in what the run actually knew at that point. Each alternative is a short, non-prescriptive description, with its assumptions, uncertainty and potential consequences. Nothing in this phase executes an alternative.

1. Extend the decision record additively with a `generated` classification for alternatives. A generated alternative carries: a summary; assumptions, each either linked to a source artifact pointer that existed before the decision or marked as an assumption without evidence; potential consequences, always hypothesized; uncertainty; and the generator that produced it. Observed, agent-stated and generated alternatives stay distinguishable in every record.
2. Build a read-only generator that takes one finished run's decision records and the artifacts they point to, and proposes zero or more alternatives per decision through a pluggable command, so no model or provider is fixed. It only sees information from before the decision. Run artifacts can be overwritten later in the run, so the generator needs an explicit boundary: an artifact counts as pre-decision only when its version at the decision time can be established, from an immutable copy, a content hash recorded before the decision, or a timestamp earlier than the decision with no later write. Anything else is excluded. Where no such evidence exists, the decision gets no generated alternatives, and the map says why. An assumption that cites a missing, later or unverifiable artifact is dropped, and so is an alternative with no grounded assumption.
3. Show generated alternatives in the map as hypotheses: visibly different from observed and agent-stated ones, with their assumptions and evidence links on selection.
4. Evaluate on the baseline run with criteria stated before looking at the output: the share of generated assumptions that are grounded, the share of decisions where the owner finds at least one alternative worth considering, and whether any alternative would have changed a decision or located a failure cause sooner. Report null results.

**Out of scope for Phase 2:** executing or replaying alternatives, predicting outcomes as facts, fixed option types or branch counts, ranking alternatives as better or worse than the chosen option.

## Future experimental phases (not implemented)

**Phase 3 — isolated replay:** capture or reconstruct an *adequate* pre-decision checkpoint, branch in isolated worktrees/environments, hold evaluation criteria fixed, prevent future-information leakage, and compare actual outputs.

**Phase 4 — adaptive search:** decide which forks deserve finite compute; compare to linear execution and to spending the same budget on one longer run. Study feasibility and diminishing returns before broad parallel search.

## Research gates

Evaluate decision-detection precision, provenance completeness, human usefulness, replay fidelity, solution quality, latency and cost. Use behavioral criteria grounded in real requirements. Report failures and null findings. Never treat a generated alternative as a measured outcome.
