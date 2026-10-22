# Decision map (Phase 1 steps 3 to 6)

**Status:** working prototype. It reads finished runs and draws their decisions; it does not change any run, runner or runtime.

Three small, dependency-free Node modules in [`decision-map/`](../decision-map):

| Module | Step | What it does |
| --- | --- | --- |
| `extract.mjs` | 3 | Reads a Development Cycle run directory (and optionally the Octopus adapter home) and writes [decision record v0](DECISION_RECORD.md) lines. Read-only. |
| `render.mjs` | 4 | Turns decision records into one self-contained HTML page: one line per decision, details on expansion. |
| `filter.mjs` | 5 | Selects which records the map shows, by impact, uncertainty, cost and reversibility. Records are never changed or dropped from the source. |

## Usage

```sh
node decision-map/extract.mjs --run <run-dir> [--adapter <octopus-home>] > decisions.jsonl
node decision-map/render.mjs --in decisions.jsonl --out map.html --title "Run map" [--min-impact high] [--exclude-unknown]
npm test
```

Other filter flags: `--min-uncertainty`, `--min-cost` (`low|medium|high`) and `--reversibility easy,costly,irreversible`. Pending and not-completed decisions are always shown, whatever the filter says, because those are the ones a person may need to act on.

## What is extracted

From the run directory:

- plan approval and the follow-up choice (continue a parent run or start fresh);
- failure classifications, folded to one record per class and phase;
- interventions: an unanswered one is `pending` with its options as listed, unexecuted alternatives; a recorded answer makes it `decided`;
- implementation and corrections attempts, with their observed outcome (a failed or interrupted attempt is `validated: no`);
- mechanical validation, each code-review council, the last go/revise/stop decision, and the delivery.

From the Octopus adapter, only artifacts linked to this run:

- design conflicts from the planning ceremony, with each seat's position as an alternative;
- per-round review findings, contested-finding debate decisions, correction reports and the quality gate.

## Linking adapter artifacts to a run

The adapter home holds artifacts from many runs. A ledger counts as this run's when one of its seats has a worktree or output path containing one of the run's attempt ids. Review rounds are linked through the review markers in seat ids. A correction report is linked by the implementer seat's stamp, or by falling inside the ledger's window (first review marker to last seat). A time window alone is not enough: a stalled correction from an earlier run can sit just before a later run's first marker.

## Rules that keep the map honest

- Every record carries evidence: artifact pointer plus the file's sha256. A record whose source cannot be read is not emitted.
- Only regular files that really live under the run or adapter directory are read, up to 16 MiB each. A symlink, at the file or in a parent directory, or a larger file counts as unreadable, so nothing from outside the given directories can reach the map. The run and adapter directories given on the command line must not be reached through a symlink, at the directory itself or any directory above it, the same rule the Development Cycle's own run reader applies. Each directory is opened once and kept open; every file is then reached from that open directory one path component at a time, so renaming or replacing a directory while the extraction runs cannot redirect a read. This uses Linux `/proc/self/fd`, like the cycle's pinned reads, so the extractor runs on Linux only.
- "Alternatives: unknown" means the source does not say. It is never shown as "none".
- Alternatives are always labelled as hypotheses, not executed.
- A record's classification is the weakest of its parts, alternatives included: an agent-written option makes the whole record agent-stated.
- Times come from artifact fields or headers when they exist (for example the quality gate's `Generated:` line); file modification time is used only where nothing else exists, and the record says so. Plan approval has no recorded time, so it uses the approved plan file's time.
- A council counts as decided when enough seats returned a verdict, even if the adapter reports quorum as not met (for example, too few approving providers). The summary says when that happened.

## Checked so far

- Tests: `tests/decision-map.test.mjs` runs on a synthetic run in `tests/fixtures/`. It checks behaviour, not output snapshots: extraction leaves the source untouched, evidence hashes match, ids are stable, unrelated adapter artifacts are excluded, pending decisions are never filtered out, and recorded text is escaped in the HTML.
- Two private baseline runs (22 and 81 records) were extracted locally and every record validated against the v0 schema. On the second run, the map shows in order what was earlier found only by reading its artifacts by hand: the corrections attempt failed after its third round, and the delivery that followed was partial. Whether that is faster for a person is not measured yet. The second run is published as a [sanitized example](../examples/baseline-round-8kv859/README.md) with its map.

## Known limits

- `final_validation_response.md` is overwritten on every automatic council round, so only the last go/revise/stop is visible.
- Correction reports linked by time window can still be wrong when two runs overlap in time on the same adapter home.
- Relevance (impact, cost, reversibility) is set by simple rules per record type; it is a starting point, not a measurement.
- The published example comes from a round that did not finish cleanly (its corrections failed and its delivery was partial). A round that finishes on its own would show the map on the ordinary path too.
