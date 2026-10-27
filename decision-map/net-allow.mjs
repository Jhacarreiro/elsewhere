// Network boundary for a sandboxed model CLI (Phase 3 step 3). The sandbox gets no network of its
// own (bwrap --unshare-net leaves it only a loopback interface); its one way out is this proxy, which
// listens on a unix socket outside the sandbox and admits HTTPS tunnels (CONNECT) only to the hosts on
// its allowlist: the model providers. Inside the sandbox a forwarder listens on loopback and passes each
// connection to that socket, so a CLI that honours HTTPS_PROXY reaches its provider and nothing else.
// Every tunnel asked for is logged, admitted or not, so a replay can show what it reached.
//
//   node decision-map/net-allow.mjs --serve <socket> --allow-host <host>... [--log <file>]
//   node decision-map/net-allow.mjs --forward <socket> --port <n> -- <command> [args...]
//   node decision-map/net-allow.mjs --check --port <n> --allow-host <host>... --deny-host <host>
//
// --forward is what the sandbox runs: it listens on 127.0.0.1:<n>, then runs the command and exits
// with its status. --check runs inside the sandbox too, behind --forward, and reports whether a direct
// connection to the outside fails, a host off the allowlist is refused and each allowed host is
// admitted; it exits nonzero if any of that fails, so the result can be kept as proof before a run.
//
// This file uses only node's own modules, so binding it alone into the sandbox is enough.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import net from "node:net";

// The port the forwarder listens on inside the sandbox. Each sandbox has its own network namespace, so
// it cannot collide with anything on the host.
export const SANDBOX_PROXY_PORT = 18080;

// Tunnels go to HTTPS only.
export const ALLOWED_PORTS = [443];

const MAX_HEADER_BYTES = 8192;

// The most of a TLS ClientHello the proxy waits for before it gives up on finding the server name.
const MAX_HELLO_BYTES = 65536;

/**
 * The server name a TLS ClientHello asks for, from the first bytes a client sends into a tunnel.
 * A CONNECT name alone does not fix where an encrypted tunnel ends up: a provider behind a shared
 * HTTPS edge would route a ClientHello naming another site to that site. So the proxy reads the name
 * the client puts in the hello and admits the tunnel only if it is the host it asked for. Encrypted
 * Client Hello hides the real name, so a hello offering it is refused.
 * @param {Buffer} buf what the client has sent so far
 * @returns {{status: "incomplete"} | {status: "ok", name: string} | {status: "bad", reason: string}}
 */
export function tlsServerName(buf) {
  // The handshake message can span records; gather their payloads until it is whole.
  let hs = Buffer.alloc(0);
  let at = 0;
  for (;;) {
    if (buf.length < at + 5) return buf.length > MAX_HELLO_BYTES ? { status: "bad", reason: "not_tls" } : { status: "incomplete" };
    if (buf[at] !== 0x16 || buf[at + 1] !== 0x03) return { status: "bad", reason: "not_tls" };
    const len = buf.readUInt16BE(at + 3);
    if (buf.length < at + 5 + len) return at + 5 + len > MAX_HELLO_BYTES ? { status: "bad", reason: "not_tls" } : { status: "incomplete" };
    hs = Buffer.concat([hs, buf.subarray(at + 5, at + 5 + len)]);
    at += 5 + len;
    if (hs.length >= 4) {
      if (hs[0] !== 0x01) return { status: "bad", reason: "not_tls" };
      if (hs.length >= 4 + hs.readUIntBE(1, 3)) break;
    }
  }
  const body = hs.subarray(4, 4 + hs.readUIntBE(1, 3));
  try {
    let p = 2 + 32;
    p += 1 + body[p];
    p += 2 + body.readUInt16BE(p);
    p += 1 + body[p];
    const end = p + 2 + body.readUInt16BE(p);
    if (end > body.length) return { status: "bad", reason: "not_tls" };
    p += 2;
    let name = null;
    while (p + 4 <= end) {
      const type = body.readUInt16BE(p);
      const len = body.readUInt16BE(p + 2);
      const data = body.subarray(p + 4, p + 4 + len);
      if (data.length !== len) return { status: "bad", reason: "not_tls" };
      if (type === 0xfe0d) return { status: "bad", reason: "encrypted_client_hello" };
      if (type === 0x0000 && data.length >= 5 && data[2] === 0x00) name = data.subarray(5, 5 + data.readUInt16BE(3)).toString("latin1");
      p += 4 + len;
    }
    return name ? { status: "ok", name } : { status: "bad", reason: "no_tls_name" };
  } catch {
    return { status: "bad", reason: "not_tls" };
  }
}

// A host is allowed when it is on the list, or under a "*.domain" entry (which does not admit the
// domain itself). Names are compared without case or a trailing dot; an IP literal is allowed only
// if it is listed as such.
export function hostAllowed(host, allow) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const e = entry.toLowerCase().replace(/\.$/, "");
    return e.startsWith("*.") ? name.endsWith(e.slice(1)) && name.length > e.length - 1 : name === e;
  });
}

// "host:port" or "[v6]:port" from a CONNECT line; null when it is neither.
export function connectTarget(line) {
  const m = /^CONNECT (\[[0-9a-fA-F:.]+\]|[^\s:[\]]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

/**
 * Starts the allowlist proxy on a unix socket.
 * @param {object} options
 * @param {string} options.socket where to listen
 * @param {string[]} options.allow hosts admitted (see hostAllowed)
 * @param {number[]} [options.ports] ports admitted, HTTPS by default
 * @param {(entry: object) => void} [options.onTunnel] told of each tunnel asked for: {at, host, port, allowed, reason?},
 *   and again, with stage "tls", when an admitted tunnel is closed because its TLS server name is not that host ({..., tls_name})
 * @param {(port: number, host: string) => import("node:net").Socket} [options.connect] how to reach the host (tests)
 * @returns {Promise<import("node:net").Server>} the listening server
 */
export function startAllowProxy({ socket, allow, ports = ALLOWED_PORTS, onTunnel = () => {}, connect = (port, host) => net.connect(port, host) }) {
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    const refuse = (status, text) => client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEADER_BYTES) {
          client.off("data", onData);
          refuse(431, "Request Header Fields Too Large");
        }
        return;
      }
      client.off("data", onData);
      client.pause();
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const target = connectTarget(line);
      if (!target) {
        onTunnel({ at: new Date().toISOString(), host: null, port: null, allowed: false, reason: "not_connect" });
        refuse(405, "Method Not Allowed");
        return;
      }
      const allowed = ports.includes(target.port) && hostAllowed(target.host, allow);
      onTunnel({ at: new Date().toISOString(), host: target.host, port: target.port, allowed, ...(allowed ? {} : { reason: ports.includes(target.port) ? "host_not_allowed" : "port_not_allowed" }) });
      if (!allowed) {
        refuse(403, "Forbidden");
        return;
      }
      const upstream = connect(target.port, target.host);
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Nothing the client sends goes on until its ClientHello names the host it asked for.
        let hello = rest;
        const check = () => {
          const found = tlsServerName(hello);
          if (found.status === "incomplete") return false;
          client.off("data", onHello);
          const name = found.status === "ok" ? found.name.toLowerCase().replace(/\.$/, "") : null;
          if (name !== target.host.toLowerCase().replace(/\.$/, "")) {
            onTunnel({ at: new Date().toISOString(), stage: "tls", host: target.host, port: target.port, allowed: false, reason: found.status === "ok" ? "tls_name_mismatch" : found.reason, ...(name ? { tls_name: name } : {}) });
            client.destroy();
            upstream.destroy();
            return true;
          }
          upstream.write(hello);
          upstream.pipe(client);
          client.pipe(upstream);
          return true;
        };
        const onHello = (chunk) => {
          hello = Buffer.concat([hello, chunk]);
          check();
        };
        if (!check()) client.on("data", onHello);
        client.resume();
      });
      upstream.on("error", () => {
        if (upstream.connecting) refuse(502, "Bad Gateway");
        else client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };
    client.on("data", onData);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(socket, () => {
      server.off("error", fail);
      done(server);
    });
  });
}

// Passes each loopback connection on <port> to the proxy's socket.
export function startForwarder(socket, port, host = "127.0.0.1") {
  const server = net.createServer((client) => {
    const upstream = net.connect(socket);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      done(server);
    });
  });
}

// The proxy settings the sandboxed command gets. NODE_USE_ENV_PROXY makes node's own fetch honour them.
export function proxyEnv(port) {
  const url = `http://127.0.0.1:${port}`;
  return { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url, all_proxy: url, NODE_USE_ENV_PROXY: "1" };
}

// What a CONNECT through the forwarder answers: the status code, or the error that stopped it.
function tunnelStatus(port, host, timeoutMs) {
  return new Promise((done) => {
    const socket = net.connect(port, "127.0.0.1");
    let head = "";
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.on("error", (err) => finish(err.code || "error"));
    socket.on("connect", () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    socket.on("data", (d) => {
      head += d.toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (m) finish(Number(m[1]));
    });
    socket.on("end", () => finish("closed"));
  });
}

// Whether a direct connection to an outside address gets through: "open", or the error that stopped it.
function directStatus(address, timeoutMs) {
  return new Promise((done) => {
    const socket = net.connect(443, address);
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.on("error", (err) => finish(err.code || "error"));
    socket.on("connect", () => finish("open"));
  });
}

/**
 * Checks the boundary from inside the sandbox. A host off the allowlist must be refused by the proxy
 * (403; any other answer or error fails); an allowed one must be admitted (200), so a boundary that blocks everything does not pass as
 * a working one; wildcard entries are not checked, having no single name.
 * @returns {Promise<{ok: boolean, found: string[]}>}
 */
export async function checkBoundary({ port, allow, deny, direct = ["1.1.1.1", "8.8.8.8"], timeoutMs = 10000 }) {
  const found = [];
  let ok = true;
  for (const address of direct) {
    const status = await directStatus(address, timeoutMs);
    found.push(`${status === "open" ? "direct_open" : "direct_blocked"} ${address} ${status}`);
    if (status === "open") ok = false;
  }
  for (const host of deny) {
    const status = await tunnelStatus(port, host, timeoutMs);
    // Only the proxy's own refusal proves the allowlist held: a timeout or a 502 could come from an
    // open proxy whose destination happened to be down.
    found.push(`${status === 403 ? "denied_host_refused" : status === 200 ? "denied_host_admitted" : "denied_host_not_refused"} ${host} ${status}`);
    if (status !== 403) ok = false;
  }
  for (const host of allow.filter((h) => !h.startsWith("*."))) {
    const status = await tunnelStatus(port, host, timeoutMs);
    found.push(`${status === 200 ? "allowed_host_admitted" : "allowed_host_not_reached"} ${host} ${status}`);
    if (status !== 200) ok = false;
  }
  return { ok, found };
}

const USAGE = "Usage: node decision-map/net-allow.mjs --serve <socket> --allow-host <host>... [--log <file>]\n       node decision-map/net-allow.mjs --forward <socket> --port <n> -- <command> [args...]\n       node decision-map/net-allow.mjs --check --port <n> --allow-host <host>... --deny-host <host>...";

function parseArgs(argv) {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const args = { allow: [], deny: [], command: split === -1 ? [] : argv.slice(split + 1) };
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--serve" && own[i + 1]) args.serve = own[++i];
    else if (own[i] === "--forward" && own[i + 1]) args.forward = own[++i];
    else if (own[i] === "--check") args.check = true;
    else if (own[i] === "--port" && Number.isInteger(Number(own[i + 1]))) args.port = Number(own[++i]);
    else if (own[i] === "--allow-host" && own[i + 1]) args.allow.push(own[++i]);
    else if (own[i] === "--deny-host" && own[i + 1]) args.deny.push(own[++i]);
    else if (own[i] === "--log" && own[i + 1]) args.log = own[++i];
    else throw new Error(`Unknown argument: ${own[i]}. ${USAGE}`);
  }
  if ([args.serve, args.forward, args.check].filter(Boolean).length !== 1) throw new Error(USAGE);
  if (args.forward && (!args.port || !args.command.length)) throw new Error(USAGE);
  if (args.check && (!args.port || !args.deny.length)) throw new Error(USAGE);
  return args;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (args.serve) {
    const log = args.log ? (entry) => appendFileSync(args.log, `${JSON.stringify(entry)}\n`, { mode: 0o600 }) : () => {};
    await startAllowProxy({ socket: args.serve, allow: args.allow, onTunnel: log });
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
  } else if (args.forward) {
    const server = await startForwarder(args.forward, args.port);
    server.unref();
    const child = spawn(args.command[0], args.command.slice(1), { stdio: "inherit" });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    child.on("error", (err) => {
      process.stderr.write(`Could not start ${args.command[0]}: ${err.message}\n`);
      process.exit(127);
    });
    child.on("exit", (status, signal) => process.exit(status ?? (signal ? 128 : 1)));
  } else {
    const result = await checkBoundary({ port: args.port, allow: args.allow, deny: args.deny });
    process.stdout.write(`${result.found.join("\n")}\n`);
    process.exit(result.ok ? 0 : 1);
  }
}
