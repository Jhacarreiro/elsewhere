import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBoundary, connectTarget, hostAllowed, startAllowProxy, startForwarder } from "../decision-map/net-allow.mjs";
import { canaryFailures, canaryScript, modelCommand, sandboxPrefix } from "../decision-map/prompt-command.mjs";

const netAllow = new URL("../decision-map/net-allow.mjs", import.meta.url).pathname;
const adapter = new URL("../decision-map/prompt-command.mjs", import.meta.url).pathname;

test("the allowlist admits listed hosts and subdomains under a wildcard entry, nothing else", () => {
  const allow = ["api.anthropic.com", "*.openai.com"];
  assert.ok(hostAllowed("api.anthropic.com", allow));
  assert.ok(hostAllowed("API.Anthropic.com.", allow));
  assert.ok(hostAllowed("auth.openai.com", allow));
  assert.ok(!hostAllowed("openai.com", allow));
  assert.ok(!hostAllowed("evilopenai.com", allow));
  assert.ok(!hostAllowed("anthropic.com", allow));
  assert.ok(!hostAllowed("api.anthropic.com.github.com", allow));
  assert.ok(!hostAllowed("github.com", allow));
  assert.ok(!hostAllowed("140.82.121.4", allow));
  assert.deepEqual(connectTarget("CONNECT api.anthropic.com:443 HTTP/1.1"), { host: "api.anthropic.com", port: 443 });
  assert.deepEqual(connectTarget("CONNECT [::1]:443 HTTP/1.1"), { host: "::1", port: 443 });
  assert.equal(connectTarget("GET http://github.com/ HTTP/1.1"), null);
  assert.equal(connectTarget("CONNECT github.com:99999 HTTP/1.1"), null);
});

// A proxy on a unix socket whose "outside" is a local echo server, whatever host is asked for, so the
// tests reach no real host.
async function withProxy(allow, fn, ports) {
  const dir = mkdtempSync(join(tmpdir(), "net-allow-"));
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((done) => echo.listen(0, "127.0.0.1", done));
  const echoPort = echo.address().port;
  const tunnels = [];
  const socket = join(dir, "proxy.sock");
  const server = await startAllowProxy({ socket, allow, ports: ports || [443], onTunnel: (e) => tunnels.push(e), connect: () => net.connect(echoPort, "127.0.0.1") });
  try {
    await fn({ socket, tunnels });
  } finally {
    server.close();
    echo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function exchange(connectTo, request, { send } = {}) {
  return new Promise((done, fail) => {
    const s = net.connect(connectTo);
    let got = "";
    s.on("error", fail);
    s.on("connect", () => s.write(request));
    s.on("data", (d) => {
      got += d.toString("latin1");
      if (send && got.includes("\r\n\r\n") && got.startsWith("HTTP/1.1 200")) {
        s.write(send);
        send = null;
      } else if (!send && got.startsWith("HTTP/1.1 200") && got.endsWith("ping")) s.end();
    });
    s.on("close", () => done(got));
  });
}

test("the proxy tunnels to an allowed host, refuses others and anything but CONNECT, and logs each request", async () => {
  await withProxy(["api.anthropic.com"], async ({ socket, tunnels }) => {
    const admitted = await exchange(socket, "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n", { send: "ping" });
    assert.ok(admitted.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n"), admitted);
    assert.ok(admitted.endsWith("ping"));
    assert.match(await exchange(socket, "CONNECT github.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403 /);
    assert.match(await exchange(socket, "CONNECT api.anthropic.com:22 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403 /);
    assert.match(await exchange(socket, "GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n"), /^HTTP\/1\.1 405 /);
    assert.match(await exchange(socket, `CONNECT ${"a".repeat(9000)}`), /^HTTP\/1\.1 431 /);
    assert.deepEqual(tunnels.map(({ host, port, allowed, reason }) => [host, port, allowed, reason]), [
      ["api.anthropic.com", 443, true, undefined],
      ["github.com", 443, false, "host_not_allowed"],
      ["api.anthropic.com", 22, false, "port_not_allowed"],
      [null, null, false, "not_connect"],
    ]);
    assert.ok(tunnels.every((t) => !Number.isNaN(Date.parse(t.at))));
  });
});

test("bytes sent right after the CONNECT header reach the tunnel", async () => {
  await withProxy(["api.anthropic.com"], async ({ socket }) => {
    const got = await exchange(socket, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\nping");
    assert.equal(got, "HTTP/1.1 200 Connection Established\r\n\r\nping");
  });
});

test("the boundary check passes only when the denied host is refused and each allowed host admitted", async () => {
  await withProxy(["api.anthropic.com", "*.openai.com"], async ({ socket }) => {
    const forwarder = await startForwarder(socket, 0);
    const port = forwarder.address().port;
    try {
      // The direct check is the network namespace's job; here an address with nothing listening stands in.
      const passed = await checkBoundary({ port, allow: ["api.anthropic.com", "*.openai.com"], deny: ["github.com"], direct: [] });
      assert.deepEqual(passed, { ok: true, found: ["denied_host_refused github.com 403", "allowed_host_admitted api.anthropic.com 200"] });
      const blocksAll = await checkBoundary({ port, allow: ["chatgpt.com"], deny: ["github.com"], direct: [] });
      assert.equal(blocksAll.ok, false);
      assert.ok(blocksAll.found.includes("allowed_host_not_reached chatgpt.com 403"));
    } finally {
      forwarder.close();
    }
  });
  // A proxy that answers anything but its refusal fails the check, even a 502 or a dropped connection.
  const dir = mkdtempSync(join(tmpdir(), "net-allow-"));
  try {
    for (const reply of ["HTTP/1.1 502 Bad Gateway\r\n\r\n", ""]) {
      const socket = join(dir, `odd-${reply.length}.sock`);
      const odd = net.createServer((c) => c.once("data", () => c.end(reply)));
      await new Promise((done) => odd.listen(socket, done));
      const forwarder = await startForwarder(socket, 0);
      try {
        const result = await checkBoundary({ port: forwarder.address().port, allow: ["*.openai.com"], deny: ["github.com"], direct: [] });
        assert.equal(result.ok, false);
        assert.match(result.found[0], /^denied_host_not_refused github\.com /);
      } finally {
        forwarder.close();
        odd.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A proxy that lets everything through fails the check.
  await withProxy(["github.com"], async ({ socket }) => {
    const forwarder = await startForwarder(socket, 0);
    try {
      const open = await checkBoundary({ port: forwarder.address().port, allow: [], deny: ["github.com"], direct: [] });
      assert.deepEqual(open, { ok: false, found: ["denied_host_admitted github.com 200"] });
    } finally {
      forwarder.close();
    }
  });
});

test("with network the sandbox has none of its own and runs the CLI behind the forwarder to the proxy's socket", () => {
  const network = { socket: "/tmp/net-allow-x/proxy.sock" };
  const { file, args } = modelCommand({ cli: "codex", cliArgs: ["exec", "-"], hide: ["/data/run"], writable: ["/w"], network }, "bwrap", ["/usr"], "/opt/node/bin/node");
  assert.equal(file, "bwrap");
  assert.ok(args.includes("--unshare-net"));
  const ro = args.flatMap((a, i) => (a === "--ro-bind" ? [args[i + 1]] : []));
  assert.ok(ro.includes("/tmp/net-allow-x") && ro.includes(netAllow));
  // The node install is the operator's to show, libraries and all; one file of it would not run.
  assert.ok(!ro.includes("/opt/node/bin/node"));
  // Mounted after /tmp's tmpfs, so the socket's directory shows inside it.
  assert.ok(args.indexOf("/tmp/net-allow-x") > args.indexOf("/tmp"));
  const env = Object.fromEntries(args.flatMap((a, i) => (a === "--setenv" ? [[args[i + 1], args[i + 2]]] : [])));
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:18080");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["/opt/node/bin/node", netAllow, "--forward", "/tmp/net-allow-x/proxy.sock", "--port", "18080", "--", "codex", "exec", "-"]);
  // The --sandbox-env prefix carries the forwarder too, so a model process started from it is behind the proxy.
  const prefix = sandboxPrefix({ cli: "bridge", cliArgs: ["a", "b"], hide: ["/data/run"], network });
  assert.deepEqual(prefix.slice(-8), ["--", process.execPath, netAllow, "--forward", "/tmp/net-allow-x/proxy.sock", "--port", "18080", "--"]);
  // Without network nothing changes.
  const plain = modelCommand({ cli: "codex", cliArgs: [], hide: ["/data/run"] }, "bwrap", ["/usr"]).args;
  assert.ok(!plain.includes("--unshare-net") && !plain.includes("HTTPS_PROXY"));
  assert.deepEqual(plain.slice(plain.indexOf("--")), ["--", "codex"]);
});

test("with network the canary fails when the model reaches a denied host or does not try", () => {
  const args = { hide: ["/r"], writable: ["/w"], allow: ["api.anthropic.com"], deny: ["github.com"] };
  assert.match(canaryScript(args), /NET %s BLOCKED/);
  assert.doesNotMatch(canaryScript({ hide: ["/r"] }), /NET/);
  assert.deepEqual(canaryFailures({ output: "HOME /w\nABSENT /r\nNET github.com BLOCKED\nEND" }, args), []);
  assert.deepEqual(canaryFailures({ output: "HOME /w\nABSENT /r\nNET github.com OPEN\nEND" }, args), ["network_open github.com"]);
  assert.deepEqual(canaryFailures({ output: "HOME /w\nABSENT /r\nNET github.com NO_NODE\nEND" }, args), ["no_network_check github.com"]);
  assert.deepEqual(canaryFailures({ output: "HOME /w\nABSENT /r\nEND" }, args), ["no_network_check github.com"]);
  assert.deepEqual(canaryFailures({ output: "HOME /w\nABSENT /r\nEND" }, { hide: ["/r"], writable: ["/w"] }), []);
});

test("--allow-host needs --hide, and --deny-host and --proxy-log need --allow-host", () => {
  for (const own of [["--allow-host", "api.anthropic.com"], ["--hide", "/x", "--deny-host", "github.com"], ["--hide", "/x", "--proxy-log", "/tmp/p"]]) {
    const result = spawnSync(process.execPath, [adapter, ...own, "--", "true"], { encoding: "utf8" });
    assert.equal(result.status, 2, own.join(" "));
  }
  const bad = spawnSync(process.execPath, [adapter, "--hide", "/x", "--allow-host", "a b", "--", "true"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

const hasNetns = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "true"]).status === 0;
test("with real bwrap the probe finds no direct network, the denied host refused and the allowed host admitted", { skip: !hasNetns && "bwrap with a network namespace is not available here" }, () => {
  const hidden = mkdtempSync(join(tmpdir(), "prompt-hidden-"));
  try {
    // The allowed host must be reachable from this machine for the check to pass; api.anthropic.com
    // is what the replays need.
    // This node and its libraries must show in the sandbox: name their directories here when they are
    // outside the system ones.
    const install = process.env.NET_ALLOW_TEST_READABLE ? process.env.NET_ALLOW_TEST_READABLE.split(":").flatMap((dir) => ["--readable", dir]) : [];
    const result = spawnSync(process.execPath, [adapter, "--hide", hidden, ...install, "--allow-host", "api.anthropic.com", "--probe"], { encoding: "utf8", timeout: 60000 });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(report.found.includes("direct_blocked 1.1.1.1 ENETUNREACH"), report.found.join("\n"));
    assert.ok(report.found.includes("denied_host_refused github.com 403"));
    assert.ok(report.found.includes("allowed_host_admitted api.anthropic.com 200"));
    assert.deepEqual(report.network.tunnels.map((t) => [t.host, t.allowed]), [["github.com", false], ["api.anthropic.com", true]]);
  } finally {
    rmSync(hidden, { recursive: true, force: true });
  }
});
