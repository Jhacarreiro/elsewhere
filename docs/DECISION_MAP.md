# Decision map (Phase 1 steps 3 to 7, Phase 2 steps 2 and 3)

**Status:** working prototype. It reads finished runs and draws their decisions. Extraction never changes a run; `map-run.mjs` only adds its own `decision-map/` folder to the run it maps. Nothing changes a runner or runtime.

Small, dependency-free Node modules in [`decision-map/`](../decision-map):

| Module | Step | What it does |
| --- | --- | --- |
| `extract.mjs` | 3 | Reads a Development Cycle run directory (and optionally the Octopus adapter home) and writes [decision record v0](DECISION_RECORD.md) lines. Read-only. |
| `render.mjs` | 4 | Turns decision records into one self-contained HTML page: one line per decision, details on expansion. Shows generated alternatives as hypotheses (Phase 2 step 3). |
| `filter.mjs` | 5 | Selects which records the map shows, by impact, uncertainty, cost and reversibility. Records are never changed or dropped from the source. |
| `map-run.mjs` | - | Extracts and renders one run and keeps the result in that run's `decision-map/` folder, for use at the end of every run. |
| `generate.mjs` | Phase 2, 2 | Proposes generated alternatives per decision through a configured command, from pre-decision artifacts only. Read-only. See [generated alternatives](#generated-alternatives). |
| `prompt-command.mjs` | Phase 2, 4 | A generator command that writes the request as a plain-text prompt for any model CLI reading stdin, and reads the JSON reply out of its answer. `--keep <dir>` keeps every exchange; `--hide <dir>` runs the CLI in a bwrap sandbox that shows only the system directories and those named with `--readable <dir>`, read-only, the `--writable <dir>` ones writable, and that directory empty, `--sandbox-env <NAME>` hands that sandbox to the CLI as an argv prefix for its model-facing process, `--probe` checks it, `--canary` checks through the full command that the model really runs in it, and the CLI gets only the basic environment plus the variables named with `--env <NAME>`. With `--allow-host <host>`, the sandbox has no network of its own and reaches only those hosts through an allowlist proxy (Phase 3 step 3, [network boundary](REPLAY.md#network-boundary)). |
| `net-allow.mjs` | Phase 3, 3 | The allowlist proxy, the forwarder that runs inside the sandbox, and the boundary check the probe runs. |
| `replay.mjs` | Phase 3, 3 | Runs one stage again from an adequate checkpoint bundle, in fresh copies mounted at the run's own paths, behind the network boundary, and records the outcome ([harness](REPLAY.md#harness)). |

## Usage

```sh
node decision-map/extract.mjs --run <run-dir> [--adapter <octopus-home>] > decisions.jsonl
node decision-map/render.mjs --in decisions.jsonl --out map.html --title "Run map" [--min-impact high] [--exclude-unknown]
node decision-map/map-run.mjs [--adapter <octopus-home>] <run-dir>
node decision-map/generate.mjs [--adapter <octopus-home>] [--decision <id>]... <run-dir> -- <command> [args...] > generated.jsonl
npm test
```

Other filter flags: `--min-uncertainty`, `--min-cost` (`low|medium|high`) and `--reversibility easy,costly,irreversible`. Pending and not-completed decisions are always shown, whatever the filter says, because those are the ones a person may need to act on.

## Map at the end of every run

`map-run.mjs` does both steps for one run and writes `decisions.jsonl` and `map.html` into a `decision-map/` folder inside the run directory, replacing any earlier map. It prints one JSON line (`ok`, `records`, `pending`, or `ok: false` with an `error`, also for a bad invocation), so it can be configured as the Development Cycle's run-end command, which appends the run directory as the last argument. Nothing is published: the map stays with the run's private state.

It reads the records from the same open run directory it writes into. The new files are created (never overwritten) in a fresh, randomly named folder inside the run, which is then renamed to `decision-map/`; the previous map folder is moved aside and only its two map files are removed. Every rename names entries of the open run directory, so swapping paths while it runs cannot make it replace anything outside the run. It refuses a `decision-map` entry that is not a plain directory.

## Generated alternatives

`generate.mjs` adds a [`generated_alternatives`](DECISION_RECORD.md#generated-alternatives-phase-2) section to each decision of one finished run (or only those named with `--decision`) and writes the records to stdout; a one-line JSON summary goes to stderr. It never writes into the run.

- **Which artifacts it may use.** The candidates are the files that the run's records point to. A file counts as pre-decision only when both its modification time and its change time are earlier than the decision. The change time cannot be set back, so a file renamed into place or with its modification time reset after the decision is excluded. The version read is then the version that existed at decision time, and its evidence carries `version_proof: pre_decision_time` with the hash of that version. At most the 8 latest such files are used, up to 12,000 characters each.
- **What makes it withhold.** A decision with no time, or with no file that passes that check, gets a `withheld` section with the reason, and the command is not called. A command that fails, times out or replies with invalid JSON also withholds, with the reason.
- **The command.** No model or provider is fixed. The command after `--` gets one JSON request on stdin: the decision's question, stage and time, and the allowed artifacts with refs. It never gets the chosen option, its outcome or the extractor's list of alternatives, because the extractor summarises those from artifacts that may be written after the decision (an attempt's summary carries its final status); what the run knew reaches the command only through the pre-decision artifacts. Its environment carries `DECISION_MAP_GENERATOR_TIMEOUT_MS` and `DECISION_MAP_GENERATOR_DEADLINE` (the timeout, and the time in epoch milliseconds when it runs out and the command is killed), so it can stop its own work in time. It answers with `{"alternatives": [...]}` on stdout, each with a summary, assumptions, potential consequences and uncertainty. A grounded assumption cites an artifact ref and a verbatim quote. A citation counts only if the ref was given and the quote is in what the command was shown. Hash and version proof come from the reader, never from the reply. An assumption whose citations all fail is dropped, not kept as a guess. The [generated rules](DECISION_RECORD.md#generated-alternatives-phase-2) then drop any alternative left without a grounded assumption.
- **What leaves the machine.** The request contains the allowed artifacts' text. If the command calls a hosted model, that text goes to its provider, so the operator chooses the command with that in mind.
- **In the map.** `render.mjs --in generated.jsonl` shows them in their own dashed block and colour, labelled "Generated hypothesis", apart from the run's own alternatives. Each one opens to its assumptions (grounded or unsupported), the evidence pointer, version proof and quoted excerpt, its hypothesized consequences and its uncertainty. A withheld section shows its reason. The renderer applies the grounding rules again, so an edited records file cannot show an ungrounded alternative. `map-run.mjs` does not call a generator: generating needs a configured command, and possibly a model, so it stays a separate step.
- **Trust in times.** The check trusts the file system's times on the machine that ran the cycle. A run directory copied elsewhere has new change times, so everything in it is withheld; that is the intended result, not an error.

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

- Tests: `tests/generate.test.mjs` checks that only pre-decision artifacts reach the command, that a reset modification time does not pass, that citations are checked against the artifact text, and that a failing command withholds. `tests/decision-map.test.mjs` runs on a synthetic run in `tests/fixtures/`. It checks behaviour, not output snapshots: extraction leaves the source untouched, evidence hashes match, ids are stable, unrelated adapter artifacts are excluded, pending decisions are never filtered out, and recorded text is escaped in the HTML.
- Two private baseline runs (22 and 81 records) were extracted locally and every record validated against the v0 schema. On the second run, the map shows in order what was earlier found only by reading its artifacts by hand: the corrections attempt failed after its third round, and the delivery that followed was partial. Whether that is faster for a person is not measured yet. The second run is published as a [sanitized example](../examples/baseline-round-8kv859/README.md) with its map.

## Known limits

- `final_validation_response.md` is overwritten on every automatic council round, so only the last go/revise/stop is visible.
- Correction reports linked by time window can still be wrong when two runs overlap in time on the same adapter home.
- Relevance (impact, cost, reversibility) is set by simple rules per record type; it is a starting point, not a measurement.
- The published example comes from a round that did not finish cleanly (its corrections failed and its delivery was partial). A round that finishes on its own would show the map on the ordinary path too.
