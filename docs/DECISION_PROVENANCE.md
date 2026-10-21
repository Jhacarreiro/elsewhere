# Decision provenance inventory

**Status:** Phase 1 step 1 of the [roadmap](ROADMAP.md). This is a read-only description of the artifacts a Development Cycle run already leaves behind, which decisions they carry, and where provenance is missing. Nothing here changes the cycle or any run.

## Method

I read two consecutive real runs of the private baseline task from October 2026, without changing them:

- a **main run**: plan, implementation through the Octopus adapter, three council review rounds with corrections, classified as review non-convergence, delivered as an open pull request with one follow-up issue per unresolved blocking finding;
- its **continuation**: a follow-up plan working only those issues on the same branch, with a design review ceremony, four council review rounds (initial and three corrections) and a clean adapter exit.

Paths below are relative: `<run>/` is the run directory the control plane owns, `<attempt>/` is `<run>/implementation_session/attempts/<attemptId>/`, and `<adapter>/` is the adapter's own results directory. No private content, prompts or deployment values are reproduced.

## What already records decisions

| Artifact | Producer | Decision it carries | Who decided | Time | Alternatives recorded |
| --- | --- | --- | --- | --- | --- |
| `<run>/plan_request.md`, `<run>/implementation_plan.md` | control plane | the approved plan and its scope | human approval through the cycle | file time only | no |
| canonical plan commit (`status.json.canonicalPlanGit.commit`) | control plane | the plan version that was approved, as a Git commit | human | commit time | no |
| `status.json.planValidation` | control plane | whether the plan was normalized or forced, and which required sections were present | control plane | `updatedAt` | not applicable |
| `<run>/followup_plan.md`, `status.json.followUp` | control plane | continue from issues on the same branch instead of a new run (parent run, generation, PR, issue numbers) | control plane, under a recorded policy | `createdAt` | no |
| design review ceremony synthesis (`<adapter>/sync-result-*.md`) | adapter, planning seats | how to resolve conflicts between seats on each planned change | council synthesizer | file time | **yes**: each conflict states the seats' positions and the resolution |
| `<attempt>/intervention.json` | implementation seat | a question that needs a new human decision, with options, pros and cons | agent asks, human answers | `createdAt` | **yes**: options with advantages and limitations, `recommendedOption` may be null |
| `<run>/implementation_intervention.json`, `implementation_intervention_response.json` | control plane | the normalized question and the human answer | human | `implementation...RequestedAt` | copied from the request |
| `<adapter>/review-round1-findings-*.json` | review seats | raw findings per round, with confidence | each reviewer | file time | no |
| `<adapter>/review-debate-*.json` | debate seat | include or exclude each contested finding, with reason and evidence (file and line) | debate seat | file time | implicit: include or exclude |
| `<adapter>/review-findings-*.json` | adapter | the findings that survived debate (`findings`) and the ones dropped (`excluded`, with reason) | council | file time | implicit |
| `<adapter>/tangle-review-corrections-N-*.md` | implementation seat | how each blocking finding was fixed, file by file | agent | file time | rarely |
| `<adapter>/tangle-validation-*.md` quality gate | adapter | proceed or retry (`Decision Branch`), success rate against threshold | adapter rule | `Generated:` line | no |
| `<run>/main_update_events.jsonl` | control plane | failure classification: class, severity, human required, safe to retry, recommended action, and the matched pattern | control plane rule | `createdAt` | no |
| `<run>/phase_notification_events.jsonl` | control plane | phase transitions and whether the operator was notified | control plane | `createdAt` | not applicable |
| `<run>/final_validation_response.md` | human, or the council for automatic rounds | `go`, `revise` or `stop`, with the reason | human or council | file time | no |
| `<run>/repository_delivery.json` | control plane | how the work was delivered: branch, commit, PR, issues, merged or not, classification | control plane | `completedAt` | no |
| `<adapter>` run ledger (`run.json`, `seats.jsonl`, `agents.jsonl`) | adapter | which provider and model took each seat, tokens, duration, status | adapter | per event | not applicable |

The observed decisions are therefore mostly **control-plane and council decisions** with good evidence (classification rules with the matched pattern, debate decisions with file and line). Agent decisions are mostly **agent-stated** prose. Explicit alternatives exist in only two places: interventions and design-ceremony conflicts.

## Gaps

| # | Gap | Effect on a decision map |
| --- | --- | --- |
| 1 | An `intervention.json` written by a run that then **exits cleanly is never read**. The control plane only looks for it on a failed exit, so the run moves to delivered and the question never reaches the operator. Observed in the continuation: a security design question with three options and no recommendation was left unasked. | A real pending human decision is invisible to the cycle and to any reader of `status.json`. The map must read the attempt directory directly and show it as pending. Reported to the Development Cycle as a defect. |
| 2 | `final_validation_response.md` is **overwritten** on every automatic council round, and the council fields in `status.json` are cleared on each correction. Only `status.previous.json` keeps one earlier version. | The run directory alone cannot reconstruct the sequence of review decisions. Round history has to come from the adapter's files. |
| 3 | Council round outputs live **in the adapter's results directory**, not the run directory, linked only by attempt id and a per-round marker in the file name. There is no per-round manifest. | The map depends on one adapter's layout. A portable record is needed (see [decision record v0](DECISION_RECORD.md)). |
| 4 | The human intervention answer file is overwritten; there is no cumulative answer list. (Already documented in the cycle's run reader.) | Earlier answers in the same run are lost. |
| 5 | `runtime_timeline.json` events are raw stdout and stderr lines with **no per-event timestamp**. | Ordering is approximate. Time must come from the decision's own artifact. |
| 6 | Most implementation choices are only in **free-form provider transcripts**, marked as untrusted output. | They can be shown only as agent-stated, never as observed reasoning. |
| 7 | Most decisions record **no alternatives**. | The map must say "alternatives unknown", not "no alternatives". Zero is a claim; unknown is the default. |
| 8 | The validation report shows the configured model but the runtime model as `unknown`. | Who decided is known by seat and configuration, not always by the model that actually ran. |
| 9 | A stalled correction round leaves a near-empty corrections file (`Status: STALLED - PARTIAL RESULTS`). | The map must show a decision that was attempted and not completed, rather than skip it. |

## What this means for step 2

- The record must point to evidence by artifact, path and content hash, because the same decision can be split across the run directory and the adapter.
- It needs an explicit state for a decision that was **asked and not answered** (gap 1) and for one **attempted and not completed** (gap 9).
- It must separate "no alternatives" from "alternatives unknown" (gap 7).
- It must carry a classification per claim (`observed`, `agent-stated`, `post-hoc-inferred`), because one decision can mix an observed outcome with agent-stated rationale.
- Time comes from the source artifact, with the source of the time recorded (gap 5).
