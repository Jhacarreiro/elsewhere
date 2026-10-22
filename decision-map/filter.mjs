// Relevance filter for decision records (Phase 1 step 5).
// It only selects records for display; records are never changed or dropped from the source.

const LEVELS = ["low", "medium", "high"];

function atLeast(value, min) {
  return LEVELS.indexOf(value) >= LEVELS.indexOf(min);
}

/**
 * @param {object[]} records decision records v0
 * @param {object} options
 * @param {"low"|"medium"|"high"} [options.minImpact]
 * @param {"low"|"medium"|"high"} [options.minUncertainty]
 * @param {"low"|"medium"|"high"} [options.minCost]
 * @param {string[]} [options.reversibility] allowed values, for example ["costly", "irreversible"]
 * @param {boolean} [options.includeUnknown=true] keep records whose axis is unknown
 * @param {string[]} [options.alwaysShow=["pending", "not_completed"]] states shown whatever the axes say
 * @returns {{ shown: object[], hidden: object[], criteria: string[] }}
 */
export function filterDecisions(records, options = {}) {
  const {
    minImpact, minUncertainty, minCost, reversibility,
    includeUnknown = true,
    alwaysShow = ["pending", "not_completed"],
  } = options;
  const criteria = [];
  if (minImpact) criteria.push(`impact ≥ ${minImpact}`);
  if (minUncertainty) criteria.push(`uncertainty ≥ ${minUncertainty}`);
  if (minCost) criteria.push(`cost ≥ ${minCost}`);
  if (reversibility?.length) criteria.push(`reversibility in ${reversibility.join(", ")}`);
  if (criteria.length && !includeUnknown) criteria.push("unknown values excluded");

  const passes = (value, test) => (value == null || value === "unknown" ? includeUnknown : test(value));
  const shown = [];
  const hidden = [];
  for (const record of records) {
    const r = record.relevance || {};
    const keep = alwaysShow.includes(record.state) || (
      (!minImpact || passes(r.impact, (v) => atLeast(v, minImpact))) &&
      (!minUncertainty || passes(r.uncertainty && r.uncertainty !== "unknown" ? r.uncertainty : record.uncertainty?.level, (v) => atLeast(v, minUncertainty))) &&
      (!minCost || passes(r.cost, (v) => atLeast(v, minCost))) &&
      (!reversibility?.length || passes(r.reversibility, (v) => reversibility.includes(v)))
    );
    (keep ? shown : hidden).push(record);
  }
  return { shown, hidden, criteria };
}
