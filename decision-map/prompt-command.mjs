// Generator command for generate.mjs that turns its JSON request into a plain-text prompt for any
// model CLI that reads a prompt on stdin and prints its answer on stdout, and turns the answer back
// into the JSON reply generate.mjs expects. Which CLI and model is the operator's choice.
//
//   node decision-map/generate.mjs <run-dir> -- node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... [--readable <dir>]... [--writable <dir>]... [--sandbox-env <NAME>] [--env <NAME>]... -- <cli> [args...]
//   node decision-map/prompt-command.mjs --hide <dir>... [--readable <dir>]... [--writable <dir>]... --probe
//
// With --keep, every exchange is written to <dir>/<decision id>.json (request, raw answer, parsed
// reply), so counts that need what the model proposed before any rule dropped it can be recomputed.
//
// With --hide, the CLI runs under bwrap (Linux) in a sandbox that shows nothing of the host by default:
// only the system directories and the few /etc files a networked CLI needs (SYSTEM_DIRS) and the --readable ones (where the CLI is installed, say)
// are there, read-only; the --writable directories (the CLI's own state) can be written; each hidden
// directory is an empty tmpfs; /tmp is a private tmpfs, /dev and /proc are its own, and the root is
// read-only. HOME is the first writable directory (or /tmp), which is also where it starts. A CLI that
// can read files then sees neither what happened after the decision nor the host's credential files,
// and cannot change anything else. The --readable directories are the operator's to keep free of
// credentials. Without bwrap the
// command fails rather than run the CLI unhidden. The CLI keeps network access to reach its model;
// keeping the commands it runs itself off the network is its own sandbox's job (for Codex,
// --sandbox read-only), which the operator names in the command line.
//
// With --allow-host <host> as well (repeatable, "*.domain" for a domain's subdomains), the sandbox gets
// no network of its own (bwrap --unshare-net) and its one way out is an allowlist proxy this command
// runs for as long as the CLI does (decision-map/net-allow.mjs): it admits HTTPS tunnels to the listed
// hosts, the model providers, and refuses the rest, the run's repository host among them. The CLI
// gets the proxy in HTTPS_PROXY and the usual variants. A CLI that ignores those variables reaches
// nothing. Each tunnel asked for is logged in the kept exchange (and appended to --proxy-log), admitted
// or not. The probe then also checks, from inside the sandbox, that a direct connection fails, that
// each --deny-host (github.com by default) is refused and that each allowed host is admitted; the
// canary has the model try to reach each --deny-host and fails if it can.
//
// With --sandbox-env NAME as well, the CLI itself runs outside the sandbox and gets the sandbox as a
// JSON argv prefix in NAME instead, to start its model-facing process in it. That is for a CLI whose
// own trusted start-up cannot run sandboxed, such as the Development Cycle's Codex bridge
// (NAME=DEVELOPMENT_CYCLE_CODEX_APP_SERVER_PREFIX), which reads OpenClaw's login before starting
// the Codex app-server that all of the model's file and command access goes through.
//
// --probe runs a shell in that same sandbox instead of a model and prints what it found: each hidden
// directory empty, the root not writable, each writable directory writable. It exits nonzero if any
// of that fails, so the result can be recorded as proof before a run.
//
// The model gets only an allowlisted environment: MODEL_ENV below, plus each variable named with
// --env (its login or provider settings, say). Nothing else of this command's environment reaches it,
// so credentials and run state kept in variables stay outside the input boundary like hidden files do.
//
// --canary sends, through that same full command, a request that asks the model to run one command
// printing HOME and listing each hidden directory and to copy its output back, instead of reading a
// decision request. The output names each line, so a model need not sort anything out itself. It passes
// only if HOME is the first writable directory (or /tmp) and each hidden directory is empty or
// absent (but for the mount points of directories named inside it), and prints the report (kept as canary.json with --keep). The probe checks the sandbox;
// the canary checks that the CLI really runs its model in it, which a --sandbox-env CLI that ignores
// the variable would not. It guards against a misconfigured command, not against a model that lies.
//
// The model is stopped before generate.mjs's deadline (DECISION_MAP_GENERATOR_TIMEOUT_MS and
// DECISION_MAP_GENERATOR_DEADLINE, or its default), so this command can keep the failed exchange instead of being killed with the model still
// running and nothing kept. The model runs in its own process group, and the whole group is stopped,
// so a CLI that forks the real model leaves nothing running into the next decision.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS } from "./generate.mjs";
import { proxyEnv, SANDBOX_PROXY_PORT, startAllowProxy } from "./net-allow.mjs";

const NET_ALLOW = fileURLToPath(new URL("./net-allow.mjs", import.meta.url));

// The model's deadline inside the generator's: a tenth of it, at most 30 s, is left to stop the
// model and write the kept exchange. Half of that is the grace between asking the model's process
// group to stop and killing it, so even a group that ignores the request is gone in time.
export function modelDeadline(generatorMs) {
  return generatorMs - Math.min(30000, generatorMs / 10);
}

export function killGrace(generatorMs) {
  return Math.min(30000, generatorMs / 10) / 2;
}

export const DEFAULT_MODEL_TIMEOUT_MS = modelDeadline(DEFAULT_TIMEOUT_MS);

// Passed to the model by default; what it needs beyond these the operator names with --env.
export const MODEL_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"];

export function modelEnv(names, from) {
  const env = {};
  for (const name of [...MODEL_ENV, ...names]) if (from[name] !== undefined) env[name] = from[name];
  return env;
}

const depth = (dir) => dir.split("/").filter(Boolean).length;

// Always shown in the sandbox, read-only, where they exist.
// Of /etc, only what a networked CLI needs to run: name resolution, TLS roots, user and group
// names, the time zone, the loader cache and the alternatives links. The rest of /etc stays out.
export const SYSTEM_DIRS = [
  "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64",
  "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/host.conf", "/etc/gai.conf",
  "/etc/ssl/certs", "/etc/ca-certificates", "/etc/pki/tls/certs", "/etc/pki/ca-trust",
  "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/ld.so.cache", "/etc/alternatives",
];

// The most the model may print; past it the model is stopped and the decision withheld.
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

const USAGE = "Usage: node decision-map/prompt-command.mjs [--keep <dir>] [--hide <dir>]... [--readable <dir>]... [--writable <dir>]... [--sandbox-env <NAME>] [--env <NAME>]... [--allow-host <host>]... [--deny-host <host>]... [--proxy-log <file>] [--canary] [--timeout-seconds <n, capped below generate.mjs's deadline>] -- <cli> [args...]\n       node decision-map/prompt-command.mjs --hide <dir>... [--readable <dir>]... [--writable <dir>]... [--allow-host <host>]... [--deny-host <host>]... --probe";

export function prompt(request) {
  const artifacts = request.artifacts.map((a) => [
    `### ${a.ref}: ${a.root}:${a.path} (written ${a.written_at}${a.truncated ? ", truncated" : ""})`,
    "",
    a.content,
  ].join("\n"));
  return [
    request.task,
    "",
    "Use only the artifacts below. Do not open files, run commands or look anything up: what happened after the decision must stay unknown to you.",
    "",
    `## Decision ${request.decision.id}`,
    "",
    `Stage: ${request.decision.stage}`,
    `Decided at: ${request.decision.decided_at}`,
    `Question: ${request.decision.question}`,
    "",
    "## Artifacts that existed before the decision",
    "",
    ...artifacts,
    "",
    "## Reply",
    "",
    "Reply with one JSON object and nothing else, in this shape (zero alternatives is a valid answer):",
    "",
    JSON.stringify(request.reply_format, null, 2),
  ].join("\n");
}

// The first JSON object with an alternatives list in the answer, allowing a fenced block or prose
// around it, braces in the prose included. Trying every opening brace can rescan the text many
// times, so the scanning is budgeted: a few passes over the text, then the answer counts as unparsed.
export function parseAnswer(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const budget = { left: 4 * text.length + 4096 };
  for (const candidate of fenced ? [fenced[1], text] : [text]) {
    for (let start = candidate.indexOf("{"); start >= 0; start = candidate.indexOf("{", start + 1)) {
      const end = closingBrace(candidate, start, budget);
      if (end === null) return null;
      if (end < 0) continue;
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (Array.isArray(value?.alternatives)) return value;
      } catch {
        // not JSON: try the next opening brace
      }
    }
  }
  return null;
}

// The index of the brace that closes the one at start, skipping braces inside JSON strings, -1 if
// none does, or null once the budget is spent.
function closingBrace(text, start, budget) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    if (--budget.left < 0) return null;
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function parseArgs(argv, env) {
  if (argv.at(-1) === "--probe") argv = [...argv.slice(0, -1), "--", "sh"];
  const split = argv.indexOf("--");
  if (split === -1 || split === argv.length - 1) throw new Error(`Missing model command after --. ${USAGE}`);
  const own = argv.slice(0, split);
  const generatorMs = Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) > 0 ? Number(env.DECISION_MAP_GENERATOR_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  // Counted from when the generator started this command, if it says, so this command's own start-up
  // comes out of the model's time and not out of the margin.
  const startedAt = Number(env.DECISION_MAP_GENERATOR_DEADLINE) > 0 ? Number(env.DECISION_MAP_GENERATOR_DEADLINE) - generatorMs : Date.now();
  const limit = Math.max(0, modelDeadline(generatorMs) - (Date.now() - startedAt));
  const args = { cli: argv[split + 1], cliArgs: argv.slice(split + 2), timeoutMs: limit, graceMs: killGrace(generatorMs), hide: [], readable: [], writable: [], env: [], allow: [], deny: [] };
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--keep" && i + 1 < own.length) args.keep = own[++i];
    else if (own[i] === "--hide" && i + 1 < own.length) args.hide.push(resolve(own[++i]));
    else if (own[i] === "--readable" && i + 1 < own.length) args.readable.push(resolve(own[++i]));
    else if (own[i] === "--writable" && i + 1 < own.length) args.writable.push(resolve(own[++i]));
    else if (own[i] === "--sandbox-env" && /^[A-Z_][A-Z0-9_]*$/.test(own[i + 1] || "")) args.sandboxEnv = own[++i];
    else if (own[i] === "--env" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(own[i + 1] || "")) args.env.push(own[++i]);
    else if (own[i] === "--allow-host" && /^(\*\.)?[A-Za-z0-9.-]+$/.test(own[i + 1] || "")) args.allow.push(own[++i]);
    else if (own[i] === "--deny-host" && /^[A-Za-z0-9.-]+$/.test(own[i + 1] || "")) args.deny.push(own[++i]);
    else if (own[i] === "--proxy-log" && i + 1 < own.length) args.proxyLog = resolve(own[++i]);
    else if (own[i] === "--canary") args.canary = true;
    else if (own[i] === "--timeout-seconds" && Number(own[i + 1]) > 0) args.timeoutMs = Math.min(Number(own[++i]) * 1000, limit);
    else throw new Error(`Unknown argument: ${own[i]}. ${USAGE}`);
  }
  if ((args.readable.length || args.writable.length || args.sandboxEnv || args.canary || args.allow.length) && !args.hide.length) throw new Error(`--readable, --writable, --sandbox-env, --allow-host and --canary only apply with --hide. ${USAGE}`);
  if ((args.deny.length || args.proxyLog) && !args.allow.length) throw new Error(`--deny-host and --proxy-log only apply with --allow-host. ${USAGE}`);
  if (args.allow.length && !args.deny.length) args.deny.push("github.com");
  // The forwarder is shown like any readable path, so a hidden directory it sits in may show its mount point.
  if (args.allow.length) args.readable.push(NET_ALLOW);
  return args;
}

// The CLI as it is run: in the bwrap sandbox when anything is hidden. With network, the sandbox has
// no network of its own and the CLI runs behind the forwarder to the proxy's socket. The forwarder is
// shown read-only wherever it is; the node that runs it (this command's own) must be in the system or
// readable directories, with whatever libraries it loads, as the CLI's own install must.
// mounts ({from, at, writable}) show a directory at another path, as the replay harness does to put
// its fresh copies where the original stage found its inputs; home overrides the HOME directory.
// setenv, when given, is set inside the sandbox only (over what bwrap inherits), so variables meant for the
// CLI never reach the launcher.
export function modelCommand({ cli, cliArgs, hide, readable = [], writable = [], network, mounts = [], home: homeDir, setenv }, bwrap = "bwrap", system = SYSTEM_DIRS.filter((dir) => existsSync(dir)), node = process.execPath) {
  if (!hide.length) return { file: cli, args: cliArgs };
  const home = homeDir || writable[0] || "/tmp";
  const net = network ? {
    mounts: [dirname(network.socket), ...(readable.includes(NET_ALLOW) ? [] : [NET_ALLOW])].flatMap((path) => ["--ro-bind", path, path]),
    env: Object.entries(proxyEnv(SANDBOX_PROXY_PORT)).flatMap(([name, value]) => ["--setenv", name, value]),
    wrap: [node, NET_ALLOW, "--forward", network.socket, "--port", String(SANDBOX_PROXY_PORT), "--"],
  } : { mounts: [], env: [], wrap: [] };
  return {
    file: bwrap,
    args: [
      ...system.flatMap((dir) => ["--ro-bind", dir, dir]),
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      // Shallower first, so a directory named inside another one wins: a hidden directory inside a
      // readable one stays empty, and a readable one inside a hidden one (the CLI's install inside
      // its state directory, say) is still there.
      ...[
        ...readable.map((dir) => ["--ro-bind", dir, dir]),
        ...writable.map((dir) => ["--bind", dir, dir]),
        ...hide.map((dir) => ["--tmpfs", dir]),
        ...mounts.map((m) => [m.writable ? "--bind" : "--ro-bind", m.from, m.at]),
      ].sort((a, b) => depth(a.at(-1)) - depth(b.at(-1))).flat(),
      ...net.mounts,
      "--remount-ro", "/",
      ...Object.entries(setenv || {}).flatMap(([name, value]) => ["--setenv", name, value]),
      "--setenv", "HOME", home,
      ...net.env,
      "--chdir", home,
      // Its own process, IPC and host-name namespaces: no signals to host processes, no System V
      // queues, segments or semaphores shared with them or left behind after it.
      "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      ...(network ? ["--unshare-net"] : []),
      "--", ...net.wrap, cli, ...cliArgs,
    ],
  };
}

// What may show inside a hidden directory: the mount points of readable, writable or other hidden
// directories named inside it (the CLI's install inside its state directory, say), by their first
// name below it.
export function mountedInside(dir, { readable = [], writable = [], hide = [], mounts = [] }) {
  return [...new Set([...readable, ...writable, ...hide, ...mounts.map((m) => m.at)].filter((d) => d.startsWith(`${dir}/`)).map((d) => d.slice(dir.length + 1).split("/")[0]))];
}

// Run in the sandbox by --probe, with the host's IPC namespace, then each hidden directory and the
// names that may show in it (one per line), then "--", then the writable ones.
const PROBE = `ok=0
if [ "$(readlink /proc/self/ns/ipc)" = "$1" ]; then echo "ipc_shared"; ok=1; else echo "ipc_private"; fi
shift
while [ "$1" != -- ]; do
  if [ -z "$2" ]; then left=$(ls -A "$1"); else left=$(ls -A "$1" | grep -vxF "$2"); fi
  if [ -z "$left" ]; then echo "hidden_empty $1"; else echo "hidden_not_empty $1"; ok=1; fi
  shift 2
done
shift
if touch /.prompt-command-probe 2>/dev/null; then rm -f /.prompt-command-probe; echo "root_writable"; ok=1; else echo "root_read_only"; fi
for dir; do
  if touch "$dir/.prompt-command-probe" 2>/dev/null; then rm -f "$dir/.prompt-command-probe"; echo "writable $dir"; else echo "not_writable $dir"; ok=1; fi
done
exit $ok`;

// The CLI as it is run with --sandbox-env: outside, with the sandbox's argv prefix in that variable.
// Everything before the CLI: bwrap's arguments and, with network, the forwarder that runs it.
export function sandboxPrefix(args, bwrap = "bwrap") {
  const sandbox = modelCommand(args, bwrap);
  return [sandbox.file, ...sandbox.args.slice(0, sandbox.args.length - 1 - args.cliArgs.length)];
}

export function sandboxEnvCommand(args, bwrap = "bwrap") {
  return { file: args.cli, args: args.cliArgs, env: { [args.sandboxEnv]: JSON.stringify(sandboxPrefix(args, bwrap)) } };
}

// Writable mounts are checked as writable where they are shown. A hidden directory that a mount
// replaces outright shows that mount's contents, not the host's, so it is not checked for emptiness.
export function probeCommand({ hide, readable, writable, network, mounts = [], home }, hostIpc = readlinkSync("/proc/self/ns/ipc")) {
  const shown = { readable, writable, hide, mounts };
  const checked = [...writable, ...mounts.filter((m) => m.writable).map((m) => m.at)];
  const empty = hide.filter((dir) => !mounts.some((m) => m.at === dir));
  return { cli: "sh", cliArgs: ["-c", PROBE, "probe", hostIpc, ...empty.flatMap((dir) => [dir, mountedInside(dir, shown).join("\n")]), "--", ...checked], hide, readable, writable, network, mounts, home };
}

// The network half of the probe, run in the same sandbox behind the same forwarder.
export function networkProbeCommand({ hide, readable, writable, network, allow, deny, mounts = [], home }, node = process.execPath) {
  return { cli: node, cliArgs: [NET_ALLOW, "--check", "--port", String(SANDBOX_PROXY_PORT), ...allow.flatMap((h) => ["--allow-host", h]), ...deny.flatMap((h) => ["--deny-host", h])], hide, readable, writable, network, mounts, home };
}

// One shell command whose output names what it found line by line, so the model only has to copy
// it: "HOME <dir>", then "ENTRY <dir> <name>" or "ABSENT <dir>" for each hidden directory, then "END".
// With network, also "NET <host> OPEN" or "NET <host> BLOCKED" for each denied host, or "NET <host>
// NO_NODE" when there is no node to try with.
export function canaryScript({ hide, allow = [], deny = [] }) {
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const quoted = hide.map(quote).join(" ");
  const net = allow.length ? ` for h in ${deny.map(quote).join(" ")}; do if ! command -v node >/dev/null; then printf 'NET %s NO_NODE\\n' "$h"; elif node -e 'fetch("https://" + process.argv[1] + "/", { signal: AbortSignal.timeout(10000) }).then(() => process.exit(0), () => process.exit(1))' "$h" 2>/dev/null; then printf 'NET %s OPEN\\n' "$h"; else printf 'NET %s BLOCKED\\n' "$h"; fi; done;` : "";
  return `printf 'HOME %s\\n' "$HOME"; for d in ${quoted}; do if [ -d "$d" ]; then ls -A "$d" | while IFS= read -r e; do printf 'ENTRY %s %s\\n' "$d" "$e"; done; else printf 'ABSENT %s\\n' "$d"; fi; done;${net} echo END`;
}

export function canaryPrompt(args) {
  return [
    "This is a sandbox check before an evaluation, not a decision. Run this one shell command; this request, unlike the evaluation's, asks you to run a command.",
    "",
    canaryScript(args),
    "",
    "Reply with one JSON object and nothing else: its output, copied exactly, as the output string.",
    "",
    JSON.stringify({ alternatives: [], output: "HOME ...\nEND" }, null, 2),
  ].join("\n");
}

// What a canary answer shows wrong; empty when it passes.
export function canaryFailures(reply, { hide, readable = [], writable = [], allow = [], deny = [] }) {
  const lines = typeof reply?.output === "string" ? reply.output.split("\n").map((line) => line.trimEnd()) : [];
  if (!lines.includes("END")) return ["no_output"];
  const failures = [];
  const home = writable[0] || "/tmp";
  const homes = lines.filter((line) => line.startsWith("HOME ")).map((line) => line.slice(5));
  if (homes.length !== 1 || homes[0] !== home) failures.push(`home ${JSON.stringify(homes.join(" ") || null)}`);
  for (const dir of hide) {
    const allowed = mountedInside(dir, { readable, writable, hide });
    const entries = lines.filter((line) => line.startsWith(`ENTRY ${dir} `)).map((line) => line.slice(`ENTRY ${dir} `.length));
    if (entries.some((name) => !allowed.includes(name))) failures.push(`hidden_not_empty ${dir}`);
  }
  if (allow.length) {
    for (const host of deny) {
      const seen = lines.filter((line) => line.startsWith(`NET ${host} `)).map((line) => line.slice(`NET ${host} `.length));
      if (seen.includes("OPEN")) failures.push(`network_open ${host}`);
      else if (seen.length !== 1 || seen[0] !== "BLOCKED") failures.push(`no_network_check ${host}`);
    }
  }
  return failures;
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

// env is the whole environment the command gets.
function run({ file, args, env }, input, timeoutMs, graceMs) {
  return new Promise((done) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
    const decoder = new StringDecoder("utf8");
    let stdout = "";
    let bytes = 0;
    let stderr = "";
    let signal = null;
    let error = null;
    const stop = (reason) => {
      if (signal) return;
      signal = reason;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs).unref();
    };
    child.stdout.on("data", (d) => {
      if (signal) return;
      bytes += d.length;
      if (bytes > MAX_ANSWER_BYTES) stop("output_limit");
      else stdout += decoder.write(d);
    });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = (stderr + d).slice(-8000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => stop("SIGTERM"), timeoutMs);
    child.on("error", (err) => { error = err; });
    child.on("close", (status, closeSignal) => {
      clearTimeout(timer);
      // Whatever the CLI left behind in its group goes too.
      if (child.pid) killGroup(child.pid, "SIGKILL");
      done({ status: signal || error ? null : status, signal: signal || closeSignal, error, stdout, stderr });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const bwrap = process.env.DECISION_MAP_BWRAP || "bwrap";
  // The allowlist proxy, for as long as this command runs, on a socket in a directory only this user
  // can open; the sandbox sees that directory read-only.
  const tunnels = [];
  if (args.allow.length) {
    const dir = mkdtempSync(join(tmpdir(), "net-allow-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    args.network = { socket: join(dir, "proxy.sock") };
    const server = await startAllowProxy({
      socket: args.network.socket,
      allow: args.allow,
      onTunnel: (entry) => {
        tunnels.push(entry);
        if (args.proxyLog) appendFileSync(args.proxyLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      },
    });
    server.unref();
  }
  const network = args.network ? { allow: args.allow, deny: args.deny, tunnels } : null;
  if (args.cli === "sh" && process.argv.at(-1) === "--probe") {
    if (!args.hide.length) {
      process.stderr.write(`--probe needs --hide. ${USAGE}\n`);
      process.exit(2);
    }
    const sandbox = modelCommand(probeCommand(args), bwrap);
    const result = await run({ ...sandbox, env: modelEnv([], process.env) }, "", args.timeoutMs, args.graceMs);
    const found = result.stdout.trim().split("\n").filter(Boolean);
    let exit = result.status ?? result.signal ?? String(result.error?.code || result.error);
    let stderr = result.stderr;
    if (args.network) {
      const check = await run({ ...modelCommand(networkProbeCommand(args), bwrap), env: modelEnv([], process.env) }, "", args.timeoutMs, args.graceMs);
      found.push(...check.stdout.trim().split("\n").filter(Boolean));
      stderr += check.stderr;
      if (exit === 0) exit = check.status ?? check.signal ?? String(check.error?.code || check.error);
    }
    process.stdout.write(`${JSON.stringify({ sandbox: [sandbox.file, ...sandbox.args.slice(0, sandbox.args.indexOf("--"))], exit, found, ...(network ? { network } : {}), ...(exit !== 0 && stderr ? { stderr: stderr.slice(-2000) } : {}) }, null, 2)}\n`);
    process.exit(exit === 0 ? 0 : 1);
  }
  const command = args.sandboxEnv ? sandboxEnvCommand(args, bwrap) : modelCommand(args, bwrap);
  const env = { ...modelEnv(args.env, process.env), ...command.env };
  // network.tunnels fills in as the CLI runs, so it is read when the exchange is kept.
  const provenance = { command: [args.cli, ...args.cliArgs], sandbox: sandboxPrefix(args, bwrap), env: Object.keys(env).sort(), ...(network ? { network } : {}) };
  if (args.canary) {
    const result = await run({ ...command, env }, canaryPrompt(args), args.timeoutMs, args.graceMs);
    const reply = result.status === 0 ? parseAnswer(result.stdout) : null;
    const failures = canaryFailures(reply, args);
    const report = { ...provenance, exit: result.status ?? result.signal ?? (result.error ? String(result.error.code || result.error) : null), answer: result.stdout, reply, ok: failures.length === 0, failures };
    if (args.keep) writeFileSync(join(args.keep, "canary.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: report.ok, failures, exit: report.exit }, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = await run({ ...command, env }, prompt(request), args.timeoutMs, args.graceMs);
  const answer = result.stdout;
  const reply = result.status === 0 ? parseAnswer(answer) : null;
  if (args.keep) {
    writeFileSync(join(args.keep, `${request.decision.id}.json`), `${JSON.stringify({
      request,
      // What ran: the CLI and its arguments (the model among them), the sandbox it ran in, and the
      // names (not values) of the variables it got.
      ...provenance,
      sandbox: args.hide.length ? provenance.sandbox : null,
      exit: result.status ?? result.signal ?? (result.error ? String(result.error.code || result.error) : null),
      answer,
      reply,
    }, null, 2)}\n`);
  }
  if (result.error) {
    process.stderr.write(`Could not start ${args.hide.length && !args.sandboxEnv ? "bwrap, which --hide needs" : args.cli}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr.slice(-2000));
    process.exit(result.status || 1);
  }
  if (!reply) {
    process.stderr.write("The model's answer had no JSON object with an alternatives list.\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(reply));
}
