import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReader } from "../decision-map/extract.mjs";
import { generateAlternatives } from "../decision-map/generate.mjs";
import { DEFAULT_MODEL_TIMEOUT_MS, killGrace, MODEL_ENV, modelCommand, modelDeadline, parseAnswer, SYSTEM_DIRS } from "../decision-map/prompt-command.mjs";
import { spawnSync } from "node:child_process";
import { DEFAULT_TIMEOUT_MS } from "../decision-map/generate.mjs";

const adapter = new URL("../decision-map/prompt-command.mjs", import.meta.url).pathname;
const model = new URL("./fixtures/generator/fake-model.mjs", import.meta.url).pathname;
const fakeBwrap = new URL("./fixtures/generator/fake-bwrap.sh", import.meta.url).pathname;
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

function generate(mode, keep, own = [], { timeoutMs, modelArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prompt-command-"));
  try {
    writeFileSync(join(dir, "plan.md"), "The plan needs the owner's approval first.\nMore text.\n");
    const reader = createReader({ runDir: dir });
    try {
      const args = [adapter, ...(keep ? ["--keep", keep] : []), ...own, "--", process.execPath, model, mode, ...modelArgs];
      return generateAlternatives({ records: [decision], reader, command: { file: process.execPath, args, label: "fake-model" }, ...(timeoutMs ? { timeoutMs } : {}) }).records[0].generated_alternatives;
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
  assert.deepEqual(parseAnswer('preface {not JSON}; answer {"alternatives": [{"summary": "a } in a string"}]} end'), { alternatives: [{ summary: "a } in a string" }] });
  // Unbalanced braces make every start rescan the rest; the budget stops that well before a full
  // quadratic scan of an 8 MiB answer.
  const started = Date.now();
  assert.equal(parseAnswer("{".repeat(2 * 1024 * 1024)), null);
  assert.ok(Date.now() - started < 2000);
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

// Gone, or a zombie waiting for whoever adopted it to reap it.
function stopsWithin(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    try {
      if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function withKeep(fn) {
  const keep = mkdtempSync(join(tmpdir(), "prompt-keep-"));
  try {
    return fn(keep, () => JSON.parse(readFileSync(join(keep, `${decision.id}.json`), "utf8")));
  } finally {
    rmSync(keep, { recursive: true, force: true });
  }
}

test("the model's deadline follows a shorter generator deadline, and a longer --timeout-seconds is capped to it", () => {
  assert.equal(modelDeadline(300000), 270000);
  assert.equal(modelDeadline(4000), 3600);
  for (const own of [[], ["--timeout-seconds", "100"]]) {
    withKeep((keep, kept) => {
      const section = generate("slow", keep, own, { timeoutMs: 4000 });
      assert.equal(section.status, "withheld");
      assert.equal(kept().exit, "SIGTERM");
    });
  }
});

test("a timed-out model's whole process group is stopped, children included", () => {
  withKeep((keep, kept) => {
    const pidFile = join(keep, "child.pid");
    generate("fork-slow", keep, ["--timeout-seconds", "1"], { modelArgs: [pidFile] });
    assert.equal(kept().exit, "SIGTERM");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(stopsWithin(pid, 3000), `child ${pid} still running`);
  });
});

test("--hide runs the CLI under bwrap showing only system and readable directories, each hidden one as an empty tmpfs", () => {
  const hidden = mkdtempSync(join(tmpdir(), "prompt-hidden-"));
  assert.deepEqual(modelCommand({ cli: "codex", cliArgs: ["exec", "-"], hide: [hidden], readable: ["/opt/cli"], writable: ["/w"] }, "bwrap", ["/usr"]), {
    file: "bwrap",
    args: ["--ro-bind", "/usr", "/usr", "--ro-bind", "/opt/cli", "/opt/cli", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", "/w", "/w", "--tmpfs", hidden, "--remount-ro", "/", "--setenv", "HOME", "/w", "--chdir", "/w", "--unshare-pid", "--die-with-parent", "--", "codex", "exec", "-"],
  });
  // Nothing outside the system directories is shown by default, the host's root least of all.
  const { args } = modelCommand({ cli: "codex", cliArgs: [], hide: [hidden] });
  const shown = args.flatMap((a, i) => (a === "--ro-bind" ? [args[i + 1]] : []));
  assert.ok(shown.every((dir) => SYSTEM_DIRS.includes(dir)), shown.join(" "));
  assert.equal(args[args.indexOf("HOME") + 1], "/tmp");
  const log = join(hidden, "..", `${hidden.split("/").pop()}.bwrap-log`);
  const saved = { bwrap: process.env.DECISION_MAP_BWRAP, log: process.env.FAKE_BWRAP_LOG };
  try {
    process.env.DECISION_MAP_BWRAP = fakeBwrap;
    process.env.FAKE_BWRAP_LOG = log;
    withKeep((keep, kept) => {
      const section = generate("peek", keep, ["--hide", hidden, "--env", "FAKE_BWRAP_LOG"], { modelArgs: [join(hidden, "outcome.md")] });
      assert.equal(section.status, "generated");
      const logged = readFileSync(log, "utf8").split("\n");
      assert.deepEqual(logged.slice(logged.indexOf("--dev"), logged.indexOf("--remount-ro") + 2), ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", resolve(hidden), "--remount-ro", "/"]);
      assert.ok(!logged.some((arg, i) => arg === "--ro-bind" && logged[i + 1] === "/"));
      assert.ok(kept().command.includes("peek"));
      assert.equal(kept().sandbox[0], fakeBwrap);
      assert.ok(kept().env.includes("FAKE_BWRAP_LOG") && kept().env.includes("PATH"));
    });
    process.env.DECISION_MAP_BWRAP = join(hidden, "no-such-bwrap");
    withKeep((keep, kept) => {
      const section = generate("peek", keep, ["--hide", hidden]);
      assert.equal(section.status, "withheld");
      assert.equal(kept().exit, "ENOENT");
    });
  } finally {
    for (const [key, value] of [["DECISION_MAP_BWRAP", saved.bwrap], ["FAKE_BWRAP_LOG", saved.log]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(hidden, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
});

test("a model that ignores the stop request is killed inside a short generator deadline, and its exchange kept", () => {
  assert.ok(modelDeadline(3000) + killGrace(3000) < 3000);
  withKeep((keep, kept) => {
    const section = generate("stubborn", keep, [], { timeoutMs: 3000 });
    assert.equal(section.status, "withheld");
    assert.equal(kept().exit, "SIGTERM");
  });
});

test("a model printing past the limit is stopped and the decision withheld", () => {
  withKeep((keep, kept) => {
    const section = generate("flood", keep, [], { timeoutMs: 20000 });
    assert.equal(section.status, "withheld");
    assert.equal(kept().exit, "output_limit");
  });
});

test("the model gets only the allowlisted environment and the variables named with --env", () => {
  const saved = process.env.PROMPT_COMMAND_TEST_SECRET;
  process.env.PROMPT_COMMAND_TEST_SECRET = "s3cret";
  try {
    assert.ok(!MODEL_ENV.includes("PROMPT_COMMAND_TEST_SECRET"));
    withKeep((keep, kept) => {
      generate("env", keep, [], { modelArgs: ["PROMPT_COMMAND_TEST_SECRET"] });
      assert.equal(kept().reply.value, null);
    });
    withKeep((keep, kept) => {
      generate("env", keep, [], { modelArgs: ["PATH"] });
      assert.equal(kept().reply.value, process.env.PATH);
    });
    withKeep((keep, kept) => {
      generate("env", keep, ["--env", "PROMPT_COMMAND_TEST_SECRET"], { modelArgs: ["PROMPT_COMMAND_TEST_SECRET"] });
      assert.equal(kept().reply.value, "s3cret");
    });
  } finally {
    if (saved === undefined) delete process.env.PROMPT_COMMAND_TEST_SECRET;
    else process.env.PROMPT_COMMAND_TEST_SECRET = saved;
  }
});

function probe(own, env = {}) {
  const result = spawnSync(process.execPath, [adapter, ...own, "--probe"], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, report: result.stdout ? JSON.parse(result.stdout) : null };
}

test("--probe reports a sandbox that does not hide as failed", () => {
  const hidden = mkdtempSync(join(tmpdir(), "prompt-hidden-"));
  try {
    writeFileSync(join(hidden, "outcome.md"), "after the decision\n");
    const { status, report } = probe(["--hide", hidden], { DECISION_MAP_BWRAP: fakeBwrap, FAKE_BWRAP_LOG: join(tmpdir(), `probe-${process.pid}.log`) });
    assert.equal(status, 1);
    assert.ok(report.found.includes(`hidden_not_empty ${hidden}`));
  } finally {
    rmSync(hidden, { recursive: true, force: true });
    rmSync(join(tmpdir(), `probe-${process.pid}.log`), { force: true });
  }
});

const hasBwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;
test("with real bwrap the probe finds hidden directories empty, the root read-only and the writable directory writable", { skip: !hasBwrap && "bwrap is not available here" }, () => {
  const hidden = mkdtempSync(join(tmpdir(), "prompt-hidden-"));
  const writable = mkdtempSync(join(tmpdir(), "prompt-writable-"));
  try {
    writeFileSync(join(hidden, "outcome.md"), "after the decision\n");
    const { status, report } = probe(["--hide", hidden, "--writable", writable]);
    assert.equal(status, 0, JSON.stringify(report));
    assert.deepEqual(report.found, [`hidden_empty ${hidden}`, "root_read_only", `writable ${writable}`]);
  } finally {
    rmSync(hidden, { recursive: true, force: true });
    rmSync(writable, { recursive: true, force: true });
  }
});

test("--sandbox-env runs the CLI outside and hands it the same sandbox as a JSON argv prefix", () => {
  const hidden = mkdtempSync(join(tmpdir(), "prompt-hidden-"));
  try {
    withKeep((keep, kept) => {
      const section = generate("env", keep, ["--hide", hidden, "--writable", "/w", "--sandbox-env", "APP_SERVER_PREFIX"], { modelArgs: ["APP_SERVER_PREFIX"] });
      assert.equal(section.status, "generated");
      const prefix = JSON.parse(kept().reply.value);
      assert.deepEqual(prefix, ["bwrap", ...modelCommand({ cli: "x", cliArgs: [], hide: [hidden], writable: ["/w"] }).args.slice(0, -1)]);
      assert.deepEqual(kept().sandbox, prefix);
      assert.ok(kept().env.includes("APP_SERVER_PREFIX"));
    });
  } finally {
    rmSync(hidden, { recursive: true, force: true });
  }
});
