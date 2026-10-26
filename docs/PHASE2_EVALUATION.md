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
  - the adapter runs it with `--hide` for the run's directories, the adapter's run data, the delivered code and the records. Under bwrap, the sandbox shows nothing of the host by default: only the system directories and the ones named with `--readable` (where the CLI is installed, kept free of credentials) are there, read-only. Only the directories named with `--writable` (the CLI's own state, which is also its `HOME`) can be written. Each hidden directory is empty, and `/tmp`, `/dev` and `/proc` are the sandbox's own. The host's home and state directories, OpenClaw's login among them, are therefore not readable; OpenClaw's state directory is also named with `--hide`, so the probe proves it. Without bwrap, the adapter fails instead of running the CLI unhidden. A CLI whose own trusted start-up cannot run in that sandbox gets it with `--sandbox-env` instead, as an argv prefix for its model-facing process. With the Development Cycle's Codex bridge, that is `--sandbox-env DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX`: the bridge reads OpenClaw's login outside the sandbox (OpenClaw refuses its state from another PID namespace) and starts the Codex app-server inside it, and all of the model's file and command access goes through the app-server;
  - the CLI gets only an allowlisted environment: the basics a process needs (`PATH`, `HOME`, `USER`, `LOGNAME`, locale, `TZ`, `TERM`, `TMPDIR`) and each variable the operator names with `--env`, such as the bridge's `OPENCLAW_STATE_DIR`. Everything else in the generator's environment, credentials included, stays out, so the environment is held to the same boundary as the files. Each kept exchange records the CLI command line (the model in it), the sandbox it ran in and the names of the variables it got; and
  - the CLI's own command sandbox is read-only without network (for Codex, `--sandbox read-only`). The CLI itself keeps network access, which it needs to reach its model. The adapter cannot enforce this for an arbitrary CLI, so it is part of the command line the results name.
  Before the run, `prompt-command.mjs --probe` is run with the same `--hide`, `--readable` and `--writable` arguments. Its report, showing each hidden directory empty, the root read-only and each writable directory writable, is kept with the results. The probe checks the sandbox, not whether a `--sandbox-env` CLI applies it (a bridge without the prefix setting ignores the variable and runs the model unsandboxed), so with `--sandbox-env` the same full command is also run once with `--canary` before the run. In place of a decision request, the canary sends one that asks the model to run commands printing `HOME` and listing each hidden directory. It passes only if `HOME` is the writable directory and each hidden directory is empty or absent. Its report (`canary.json`) is kept too. It guards against a misconfigured command, not against a model that lies. A failed probe or canary stops the run.
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
