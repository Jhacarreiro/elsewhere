// Generated alternatives (Phase 2 step 1).
// Enforces the record's rules for alternatives proposed after the run, so nothing reaches the map
// that presents an ungrounded or post-decision claim as grounded. The input record is not mutated.

const PROOFS = new Set(["immutable_copy", "pre_decision_hash", "pre_decision_time"]);
const SHA256 = /^[0-9a-f]{64}$/;

function usable(evidence) {
  return evidence && ["run", "adapter", "repository"].includes(evidence.root) &&
    typeof evidence.pointer === "string" && evidence.pointer.length > 0 &&
    SHA256.test(evidence.sha256 || "") && PROOFS.has(evidence.version_proof);
}

function withheld(section, reason) {
  return { ...section, status: "withheld", reason, items: [] };
}

const instant = (value) => (typeof value === "string" ? Date.parse(value) : NaN);

// The cutoff is only trustworthy if it is the record's own decision time: a missing decision time
// leaves nothing to cut at, and a different boundary (later, or from another source) could let
// evidence written after the decision count as pre-decision.
function boundaryProblem(time, boundary) {
  const decided = instant(time?.value);
  if (Number.isNaN(decided)) return { dropped: "no decision time", reason: "No decision time, so no pre-decision cutoff." };
  if (instant(boundary?.value) !== decided || boundary?.source !== time.source) {
    return { dropped: "boundary is not the decision time", reason: "The evidence cutoff does not match the decision time." };
  }
  return null;
}

/**
 * Applies the generated-alternatives rules to one decision record.
 * - Without a decision time there is no evidence cutoff, so nothing is generated; a boundary that is
 *   not the record's decision time is not trusted either.
 * - A grounded assumption keeps only evidence with a version proof; with none left it is dropped,
 *   not relabelled, because its claim was made on evidence that cannot be checked.
 * - An alternative with no grounded assumption left is dropped.
 * - Every kept alternative is classified generated and unexecuted.
 * @param {object} record decision record v0
 * @returns {{ record: object, dropped: { option_id: string|null, summary: string, reason: string }[] }}
 */
export function applyGeneratedRules(record) {
  const section = record.generated_alternatives;
  if (!section) return { record, dropped: [] };
  const dropped = [];
  const items = section.items || [];
  if (section.status === "withheld") {
    for (const item of items) dropped.push({ option_id: item.option_id ?? null, summary: item.summary, reason: "section withheld" });
    return { record: { ...record, generated_alternatives: withheld(section, section.reason || "withheld without a reason") }, dropped };
  }
  const cutoff = boundaryProblem(record.time, section.boundary);
  if (cutoff) {
    for (const item of items) dropped.push({ option_id: item.option_id ?? null, summary: item.summary, reason: cutoff.dropped });
    return { record: { ...record, generated_alternatives: withheld(section, cutoff.reason) }, dropped };
  }
  const kept = [];
  for (const item of items) {
    const assumptions = [];
    for (const a of item.assumptions || []) {
      if (a.basis === "unsupported") {
        assumptions.push({ ...a, evidence: [] });
        continue;
      }
      // Any basis other than the two the record defines is not a claim of grounding.
      if (a.basis !== "grounded") continue;
      const evidence = (a.evidence || []).filter(usable);
      if (evidence.length) assumptions.push({ ...a, evidence });
    }
    if (!assumptions.some((a) => a.basis === "grounded")) {
      dropped.push({ option_id: item.option_id ?? null, summary: item.summary, reason: "no grounded assumption" });
      continue;
    }
    kept.push({ ...item, assumptions, classification: "generated", executed: "no" });
  }
  return { record: { ...record, generated_alternatives: { ...section, status: "generated", items: kept } }, dropped };
}
