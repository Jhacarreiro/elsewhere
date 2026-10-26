import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { generateAlternatives } from "../decision-map/generate.mjs";
import { DEFAULT_MODEL_TIMEOUT_MS, parseAnswer } from "../decision-map/prompt-command.mjs";
import { DEFAULT_TIMEOUT_MS } from "../decision-map/generate.mjs";

const adapter = new URL("../decision-map/prompt-command.mjs", import.meta.url).pathname;
const model = new URL("./fixtures/generator/fake-model.mjs", import.meta.url).pathname;
const decision = {
  schema_version: 0,
  id: "dec_0123456789abcdef",
  stage: "planning",
  time: { value: new Date(Date.now() + 3600000).toISOString(), source: "artifact_field" },
  question: "Approve the plan?",
  state: "decided",
  chosen: { summary: "Approved" },
  alternatives: { status: "unknown", items: [] },
  evidence: [{ artifact: "x", root: "run", pointer: "plan.md", sha256: "b".repeat(64) }],
};

function generate(mode, keep, own = []) {
  const dir = mkdtempSync(join(tmpdir(), "prompt-command-"));
  try {
    writeFileSync(join(dir, "plan.md"), "The plan needs the owner's approval first.\nMore text.\n");
    const reader = createReader({ runDir: dir });
    try {
      const args = [adapter, ...(keep ? ["--keep", keep] : []), ...own, "--", process.execPath, model, mode];
      return generateAlternatives({ records: [decision], reader, command: { file: process.execPath, args, label: "fake-model" } }).records[0].generated_alternatives;
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a model's fenced JSON answer becomes a grounded generated alternative, and the exchange is kept", () => {
  const keep = mkdtempSync(join(tmpdir(), "prompt-keep-"));
  try {
    const section = generate("fenced", keep);
    assert.equal(section.status, "generated");
    assert.equal(section.items[0].summary, "Ask first");
    assert.equal(section.items[0].assumptions[0].basis, "grounded");
    assert.equal(section.items[0].assumptions[0].evidence[0].excerpt, "The plan needs the owner's approval first.");
    assert.deepEqual(readdirSync(keep), [`${decision.id}.json`]);
    const kept = JSON.parse(readFileSync(join(keep, `${decision.id}.json`), "utf8"));
    assert.equal(kept.exit, 0);
    assert.match(kept.answer, /Here is my answer/);
    assert.equal(kept.reply.alternatives.length, 1);
    assert.equal(kept.request.decision.question, "Approve the plan?");
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
});

test("a model that fails or answers without JSON withholds the decision", () => {
  assert.match(generate("fail").reason, /exited with status 4/);
  assert.match(generate("prose").reason, /exited with status 1/);
});

test("the answer parser takes the alternatives object out of surrounding text", () => {
  assert.deepEqual(parseAnswer('Sure: {"alternatives": []} and {stray}'), { alternatives: [] });
  assert.equal(parseAnswer('{"other": 1}'), null);
  assert.equal(parseAnswer("no json"), null);
});

test("a model past its deadline is stopped and its exchange kept, inside the generator's own deadline", () => {
  assert.ok(DEFAULT_MODEL_TIMEOUT_MS < DEFAULT_TIMEOUT_MS);
  const keep = mkdtempSync(join(tmpdir(), "prompt-keep-"));
  try {
    const section = generate("slow", keep, ["--timeout-seconds", "1"]);
    assert.equal(section.status, "withheld");
    const kept = JSON.parse(readFileSync(join(keep, `${decision.id}.json`), "utf8"));
    assert.equal(kept.exit, "SIGTERM");
    assert.equal(kept.reply, null);
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
});
