# Phase 2 evaluation protocol (step 4)

**Status:** fixed before any generated output was looked at. Results go in a separate section, added later, and do not change anything above it.

This is the protocol for [roadmap](ROADMAP.md) Phase 2 step 4: run the [generator of contextual alternatives](DECISION_MAP.md#generated-alternatives) on the baseline run and judge the result against criteria stated in advance.

## Run and decisions

- **Run.** The baseline run used for Phase 1, the continuation run that delivered the social-publisher PR (the same run as the public demo example). It has 81 decision records with the extractor at the time of writing.
- **All decisions** go to the generator, for the automatic measures below.
- **Rated sample.** The owner rates only these decisions, chosen by rule and not by looking at the output: every decision with `relevance.impact` of `high`, every decision taken by a human, and every decision whose state is `pending` or `not_completed`. With the current extractor that is at most 11 decisions. If the extractor changes before the run, the rule stays and the count is reported.

## Generator

- One command, configured once and used for every decision: a model reached through the Development Cycle's own routing, with the model named in the results. No other model is tried after looking at the output. If the command fails for a decision, that decision counts as withheld; it is not retried with a different prompt or model.
- The command sees only what the generator gives it: the decision's question, stage and time, and the artifacts that provably existed, unchanged, before the decision. The command is [`decision-map/prompt-command.mjs`](../decision-map/prompt-command.mjs) in front of the model's CLI. A model that could read what happened after the decision would make the evaluation worthless, so when that CLI is an agent that can read files or run commands:
  - the prompt tells it not to;
  - the adapter runs it with `--hide` for the run's directories, the adapter's run data, the delivered code and the records. Under bwrap, the sandbox shows nothing of the host by default: only the system directories (`/usr` and the libraries, and of `/etc` only name resolution, TLS roots, user names, time zone and loader files) and the ones named with `--readable` (where the CLI is installed, kept free of credentials) are there, read-only. Only the directories named with `--writable` (the CLI's own state, which is also its `HOME`) can be written. Each hidden directory is empty, and `/tmp`, `/dev` and `/proc` are the sandbox's own. The host's home and state directories, OpenClaw's login among them, are therefore not readable; OpenClaw's state directory is also named with `--hide`, so the probe proves it. Without bwrap, the adapter fails instead of running the CLI unhidden. A CLI whose own trusted start-up cannot run in that sandbox gets it with `--sandbox-env` instead, as an argv prefix for its model-facing process. With the Development Cycle's Codex bridge, that is `--sandbox-env DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX`: the bridge reads OpenClaw's login outside the sandbox (OpenClaw refuses its state from another PID namespace) and starts the Codex app-server inside it, and all of the model's file and command access goes through the app-server;
  - the CLI gets only an allowlisted environment: the basics a process needs (`PATH`, `HOME`, `USER`, `LOGNAME`, locale, `TZ`, `TERM`, `TMPDIR`) and each variable the operator names with `--env`, such as the bridge's `OPENCLAW_STATE_DIR`. Everything else in the generator's environment, credentials included, stays out, so the environment is held to the same boundary as the files. Each kept exchange records the CLI command line (the model in it), the sandbox it ran in and the names of the variables it got; and
  - the CLI's own command sandbox is read-only without network (for Codex, `--sandbox read-only`). The CLI itself keeps network access, which it needs to reach its model. The adapter cannot enforce this for an arbitrary CLI, so it is part of the command line the results name.
  Before the run, `prompt-command.mjs --probe` is run with the same `--hide`, `--readable` and `--writable` arguments. Its report, showing each hidden directory empty, the root read-only and each writable directory writable, is kept with the results. The probe checks the sandbox, not whether a `--sandbox-env` CLI applies it (a bridge without the prefix setting ignores the variable and runs the model unsandboxed), so with `--sandbox-env` the same full command is also run once with `--canary` before the run. In place of a decision request, the canary sends one that asks the model to run commands printing `HOME` and listing each hidden directory. It passes only if `HOME` is the writable directory and each hidden directory is empty or absent, apart from the mount points of directories named inside it (the CLI's install inside OpenClaw's state directory). The probe applies the same rule. Its report (`canary.json`) is kept too. It guards against a misconfigured command, not against a model that lies. A failed probe or canary stops the run.
- Each exchange (request, raw answer, parsed reply) is kept next to the records with `--keep`, so every count below can be recomputed, including assumptions the rules dropped.

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

## Results (2026-10-26)

Added after the run. Nothing above this section was changed.

**Setup.** Generator at `fa66c93`. Model: Codex `gpt-5.6-sol` through the Development Cycle's Codex bridge, with `--sandbox read-only`. The probe and the canary passed with the same arguments right before the run, and their reports are kept with the results. Two additions to the protocol, both stricter than it requires:
- More directories were hidden: besides the run and OpenClaw's state, the adapter's state, both checkouts of the delivered code and the host's shared scratch directory.
- Each decision got a fresh writable directory (the CLI's `HOME`), so nothing one decision's model left behind could reach the next.

**Ratings.** The owner delegated measures 2 and 3 to the operator who ran the evaluation. So they are the operator's judgment, not the owner's, and the operator also knew how the run ended.

| | Count |
| --- | --- |
| Decisions | 81 |
| With pre-decision artifacts | 79 |
| Withheld (no artifact shown to predate the decision) | 2: one `planning`, one `follow_up` |
| Command failures | 0 |
| Alternatives proposed / kept | 244 / 244 |
| Assumptions proposed | 690 |
| Grounded after the citation check | 669 |
| Unsupported (no citation) | 0 |
| Citation failed, assumption dropped | 21 |

1. **Grounding: 669 of 690, 97% (threshold 60%). Positive.** Grounded means only that the quote is verbatim in an artifact that predates the decision. It does not mean the assumption is right or that the alternative is new. Many alternatives restate options the artifacts already listed, such as the stronger-authentication options a pending decision enumerated itself.
2. **Worth considering: 9 of 9 (threshold 30%). Positive.** The rule picked 10 decisions: 7 `review` decisions with `high` impact (which findings stand after review rounds 0–3, across the two review passes), the `review` decision that did not complete (does the council approve the delivered code), the `implementation` decision still pending (which stronger operator-approval authentication should replace the interim check), and the `planning` decision taken by a human (approve the implementation plan). The plan approval was withheld, so 9 rated decisions got alternatives. This measure is weak: an alternative that restates a listed option counts.
3. **Would it have mattered.**
   - **Changed the decision: 5 of 10.** All five carry the same alternative in different words: take the operator-authentication question out of the review loop and put it to the owner first. In round 0 of both review passes and round 2 of the first, the review would have stopped and escalated instead of correcting an interim check, or tracked the question as the owner's decision instead of a standing finding. In the pending authentication decision, the generated "operator-only approval path" is the one the owner later chose. In the incomplete council approval, the review would have paused for that decision. In the other four review rounds, the alternatives regroup the same findings without a different outcome.
   - **Review that did not converge within the correction cap: yes, earlier.** At round 0 of both review passes, alternatives point at the cause the run reached only at the cap: findings tied to the undecided authentication question keep standing in every round, so corrections cannot converge until that question is decided.
   - **Finding that an agent could forge an approval: no.** It was already known before this run started, and the alternatives cite it rather than find it.

**Limits.** One run, one model, and ratings by someone who knew the outcome (see Known limits). Findings that stand across rounds repeat in the run's records, so the five "changed the decision" cases are one idea seen five times, not five independent ones.
