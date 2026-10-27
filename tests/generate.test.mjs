import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test("the command never sees the chosen option, its outcome or the extractor's list of alternatives", () => {
  withRun({ "plan.md": "Plan" }, (dir, reader) => {
    const input = {
      ...decision(later(3600000), ["plan.md"]),
      chosen: { summary: "Attempt completed with exit 0 at a later time" },
      alternatives: { status: "listed", items: [{ summary: "Written after the decision" }] },
    };
    const { records } = generateAlternatives({ records: [input], reader, command: command("request") });
    const seen = JSON.parse(records[0].generated_alternatives.items[0].summary);
    assert.deepEqual(Object.keys(seen).sort(), ["decided_at", "id", "question", "stage"]);
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
    // The copy writes its files one after another, a few milliseconds apart, so a decision timed by one
    // copied file would find the files copied before it older. They are all given one time, as if
    // written at once.
    const now = new Date();
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), now, now);
    }
    const out = execFileSync(process.execPath, [new URL("../decision-map/generate.mjs", import.meta.url).pathname, dir, "--", process.execPath, fake], { encoding: "utf8" });
    const records = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(records.length > 0);
    // The copied fixture was written just now, after every recorded decision, so nothing predates them.
    assert.ok(records.every((r) => r.generated_alternatives.status === "withheld"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records and artifacts come from the same pinned adapter tree, even if its path is replaced", async () => {
  const { extract, pinRoot } = await import("../decision-map/extract.mjs");
  const { closeSync, renameSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "generate-adapter-"));
  try {
    const run = join(dir, "run");
    const adapter = join(dir, "adapter");
    cpSync(runFixture, run, { recursive: true });
    cpSync(new URL("./fixtures/octopus/", import.meta.url).pathname, adapter, { recursive: true });
    const runRoot = pinRoot("run", run);
    const adapterRoot = pinRoot("adapter", adapter);
    try {
      const records = extract({ runDir: run, runRoot, adapterRoot });
      const adapterFiles = records.flatMap((r) => r.evidence).filter((e) => e.root === "adapter");
      assert.ok(adapterFiles.length > 0);
      // Swap a different, empty tree in at the adapter path after extraction.
      renameSync(adapter, join(dir, "adapter-old"));
      mkdirSync(adapter);
      const reader = createReader({ runDir: run, runRoot, adapterRoot });
      try {
        const rel = adapterFiles[0].pointer.split("#")[0];
        assert.equal(reader.read("adapter", rel)?.sha, adapterFiles[0].sha256, "the reader still sees the tree the records came from");
      } finally {
        reader.close();
      }
    } finally {
      closeSync(adapterRoot.fd);
      closeSync(runRoot.fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
