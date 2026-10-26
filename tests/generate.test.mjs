import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { generateAlternatives } from "../decision-map/generate.mjs";

const fake = new URL("./fixtures/generator/fake-generator.mjs", import.meta.url).pathname;
const runFixture = new URL("./fixtures/run-a/", import.meta.url).pathname;
const command = (mode = "cite") => ({ file: process.execPath, args: [fake, mode], label: "fake" });
const later = (ms) => new Date(Date.now() + ms).toISOString();

function withRun(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "generate-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const reader = createReader({ runDir: dir });
    try {
      return fn(dir, reader);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const decision = (time, pointers) => ({
  schema_version: 0,
  id: "dec_0123456789abcdef",
  stage: "planning",
  time: { value: time, source: "artifact_field" },
  question: "Approve the plan?",
  state: "decided",
  chosen: { summary: "Approved" },
  alternatives: { status: "unknown", items: [] },
  evidence: pointers.map((pointer) => ({ artifact: "x", root: "run", pointer, sha256: "b".repeat(64) })),
});

test("only artifacts written before the decision reach the command, and grounding comes from the reader", () => {
  withRun({ "plan.md": "The plan needs the owner's approval first." }, (dir, reader) => {
    const { records, dropped } = generateAlternatives({ records: [decision(later(3600000), ["plan.md#L1"])], reader, command: command() });
    const section = records[0].generated_alternatives;
    assert.equal(section.status, "generated");
    assert.deepEqual(section.boundary, records[0].time);
    assert.equal(section.generator.command, "fake");
    assert.deepEqual(section.items.map((i) => i.summary), ["Ask the owner before approving"]);
    const [grounded, guess] = section.items[0].assumptions;
    assert.equal(grounded.evidence.length, 1, "the quote that is not in the file is not evidence");
    assert.equal(grounded.evidence[0].pointer, "plan.md");
    assert.equal(grounded.evidence[0].version_proof, "pre_decision_time");
    assert.match(grounded.evidence[0].sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(grounded.evidence[0].sha256, "b".repeat(64));
    assert.equal(guess.basis, "unsupported");
    assert.deepEqual(dropped.map((d) => d.summary), ["Cite something that does not exist", "Only a guess"]);
  });
});

test("an artifact changed after the decision is never shown, even with its modification time set back", () => {
  withRun({ "before.md": "Earlier context", "after.md": "Written after the decision" }, (dir, reader) => {
    const past = new Date(Date.now() - 3600000);
    utimesSync(join(dir, "after.md"), past, past);
    const decidedAt = new Date(Date.now() - 1800000).toISOString();
    const { records } = generateAlternatives({ records: [decision(decidedAt, ["after.md"])], reader, command: command("echo") });
    assert.equal(records[0].generated_alternatives.status, "withheld");
    assert.match(records[0].generated_alternatives.reason, /predate/);
  });
});

test("a decision without a time, or without pre-decision artifacts, is withheld without calling the command", () => {
  withRun({ "plan.md": "Plan" }, (dir, reader) => {
    const { records } = generateAlternatives({
      records: [decision(null, ["plan.md"]), decision(new Date(0).toISOString(), ["plan.md"])],
      reader,
      command: { file: "/nonexistent/generator", label: "missing" },
    });
    assert.match(records[0].generated_alternatives.reason, /No decision time/);
    assert.match(records[1].generated_alternatives.reason, /predate/);
  });
});

test("a failing or garbled command withholds the section and says why", () => {
  withRun({ "plan.md": "Plan" }, (dir, reader) => {
    for (const [mode, reason] of [["fail", /exited with status 3/], ["garbage", /invalid JSON/]]) {
      const { records } = generateAlternatives({ records: [decision(later(3600000), ["plan.md"])], reader, command: command(mode) });
      assert.equal(records[0].generated_alternatives.status, "withheld");
      assert.match(records[0].generated_alternatives.reason, reason);
    }
  });
});

test("unselected decisions are passed through untouched", () => {
  withRun({ "plan.md": "Plan" }, (dir, reader) => {
    const input = decision(later(3600000), ["plan.md"]);
    const { records } = generateAlternatives({ records: [input], reader, command: command(), select: () => false });
    assert.equal(records[0], input);
  });
});

test("the command line reads a run, writes records to stdout and leaves the run untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "generate-cli-"));
  try {
    cpSync(runFixture, dir, { recursive: true });
    const out = execFileSync(process.execPath, [new URL("../decision-map/generate.mjs", import.meta.url).pathname, dir, "--", process.execPath, fake], { encoding: "utf8" });
    const records = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(records.length > 0);
    // The copied fixture was written just now, after every recorded decision, so nothing predates them.
    assert.ok(records.every((r) => r.generated_alternatives.status === "withheld"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
