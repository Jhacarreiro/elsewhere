# Example: one real baseline round (8kv859)

This is Phase 1 step 6 of the [roadmap](../../docs/ROADMAP.md): a decision map built from one real run of the Development Cycle, not from synthetic fixtures.

- [`decisions.jsonl`](decisions.jsonl): 81 [decision records v0](../../docs/DECISION_RECORD.md), one per line, as written by [`decision-map/extract.mjs`](../../decision-map/extract.mjs). Every record validates against [the schema](../../schemas/decision-record.v0.schema.json).
- [`map.html`](map.html): the same records drawn by [`decision-map/render.mjs`](../../decision-map/render.mjs), with no relevance filter. Open it in a browser; it has no external dependencies.

## The run

Run `social-publisher-20261020135547455-8kv859` worked on the Social Publisher baseline task (a small tool that drafts posts for X and LinkedIn and only publishes after the operator approves). It was a follow-up of an earlier round that had stopped on review non-convergence, and it continued that round's open issues. It ran from 2026-10-20 13:55 UTC to 2026-10-21 17:26 UTC, with the runtime restarted in between.

## What the map shows

The map groups records by stage (follow-up, planning, implementation, review and so on), in time order within each stage, so it is not one timeline. Taken in time order, the records show what was earlier found only by reading the run's artifacts by hand:

1. The first implementation went through three correction rounds between four reviews; the quality gate then let it proceed as "challenged", and it was delivered for final validation.
2. One question raised by the implementing agent, which stronger authentication should guard the operator's approval, stayed `pending`. No option was recommended, so the map shows it with high uncertainty.
3. Mechanical validation passed. The first code-review council returned no verdict (`not_completed`); the second had all five seats answering "revise", which sent the work to a corrections attempt.
4. That corrections attempt ran three more review and correction rounds, still finding new issues each round, and then ended failed after its third correction round.
5. The delivery that followed is marked partial: an open pull request plus ten follow-up issues.

What the map alone does not show: the commit in the delivery record is the pre-correction checkout, because the failed corrections attempt left its work uncommitted. That was found by comparing the delivery commit with the corrections worktree, and it has since been fixed in the Development Cycle. The map pointed at where to look (a failed corrections attempt directly before a partial delivery); it did not explain it.

## What was changed before publishing

The records are the extractor's output with only these replacements, made before the file left the machine that ran the round:

- absolute paths on that machine became `<private-path>` (two places in agent-written text);
- IP addresses, email addresses, token-like strings and `Bearer` values would have become `<ip>`, `<email>` and `<secret>`; none were present;
- the one link into the task repository, which is private, became `<task-repository>/issues/10`.

Every record was then read in full for other private details (hostnames, user names, internal ports, configuration values); none were found. The environment variable names and test values that appear are the task's own. Nothing else was edited. Agent-written text (findings, rationales, intervention questions) is kept as written, apart from that link. Evidence pointers and sha256 hashes refer to the run's private artifacts: they show which file each record came from, but they cannot be checked from this repository.

## Regenerating the map

```sh
node decision-map/render.mjs --in examples/baseline-round-8kv859/decisions.jsonl --out examples/baseline-round-8kv859/map.html --title "Baseline round 8kv859: decision map"
```

Add `--min-impact medium` to see the shorter map a person would read first; pending and not-completed decisions stay visible under any filter.
