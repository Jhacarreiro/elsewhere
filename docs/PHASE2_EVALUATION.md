# Phase 2 evaluation protocol (step 4)

**Status:** fixed before any generated output was looked at. Results go in a separate section, added later, and do not change anything above it.

This is the protocol for [roadmap](ROADMAP.md) Phase 2 step 4: run the [generator of contextual alternatives](DECISION_MAP.md#generated-alternatives) on the baseline run and judge the result against criteria stated in advance.

## Run and decisions

- **Run.** The baseline run used for Phase 1, the continuation run that delivered the social-publisher PR (the same run as the public demo example). It has 81 decision records with the extractor at the time of writing.
- **All decisions** go to the generator, for the automatic measures below.
- **Rated sample.** The owner rates only these decisions, chosen by rule and not by looking at the output: every decision with `relevance.impact` of `high`, every decision taken by a human, and every decision whose state is `pending` or `not_completed`. With the current extractor that is at most 11 decisions. If the extractor changes before the run, the rule stays and the count is reported.

## Generator

- One command, configured once and used for every decision: a model reached through the Development Cycle's own routing, with the model named in the results. No other model is tried after looking at the output. If the command fails for a decision, that decision counts as withheld; it is not retried with a different prompt or model.
- The command sees only what the generator gives it: the decision's question, stage and time, and the artifacts that provably existed, unchanged, before the decision.
- Each command reply is kept next to the records, so every count below can be recomputed.

## Measures and what counts as a positive result

Each measure has a threshold set now. A measure below its threshold is a null result and is reported as such.

1. **Grounding.** The share of the assumptions the command proposes that end as `grounded` after the citation check (ref given, quote verbatim in the pre-decision artifact). The denominator is every proposed assumption, including the ones the rules drop. Positive if at least 60%. Also reported: decisions with pre-decision artifacts, decisions withheld and why, alternatives proposed, and alternatives kept.
2. **Worth considering.** For each decision in the rated sample, the owner answers yes or no: is at least one generated alternative worth considering at that point? Positive if yes for at least 30% of the rated decisions that got any alternative.
3. **Would it have mattered.** For each rated decision, the owner answers yes or no: would any alternative have changed the decision? For the run's known failures (the review that did not converge within the correction cap, and the finding that an agent could forge an approval), the owner answers whether any alternative points at the cause earlier than the run found it. These are reported as counts, with the decision and the alternative named. Zero is a valid, reported result.

## Known limits

- **Hindsight.** The owner knows how the run ended. That can make an alternative look better or worse than it would have looked at the time. It is recorded, not corrected for.
- **One run, one model.** The result says nothing about other runs or models.
- **No outcome is measured.** No alternative is executed. "Would have changed the decision" is the owner's judgment, never an observed outcome.
- **Time checks.** Pre-decision artifacts are established from file modification and change times on the machine that ran the cycle. A decision without such artifacts is withheld, and the count is reported.

## Publication

This repository is public. The results section gives the counts, the shares, the thresholds and the model, and names decisions only by stage and question. Artifact text, quotes and per-decision ratings stay in the private run directory and are not committed here.
