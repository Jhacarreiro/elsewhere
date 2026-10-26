# Isolated replay (Phase 3 step 3)

**Status:** in progress. The network boundary is built and checked on the owner's machine; the harness that materializes a checkpoint and runs a stage in it is not built yet. Nothing here has run a replay.

A replay runs one stage again from an adequate [checkpoint](CHECKPOINT_RECORD.md). It must not see what happened after the decision, through files or through the network. Files are handled by the [sandbox adapter](../decision-map/prompt-command.mjs) from Phase 2: the run, the adapter's state and anything written later are hidden, and the CLI sees only system directories and the ones named readable or writable. This page covers the network.

## Network boundary

The run's repository host, its pull requests and issues, the project's wiki and any other live source can all show what happened after the decision. So the stage may reach its model providers and nothing else.

- The sandbox gets no network of its own (`bwrap --unshare-net`), only a loopback interface. A direct connection to any outside address fails.
- Its one way out is an allowlist proxy, [`decision-map/net-allow.mjs`](../decision-map/net-allow.mjs). It listens on a unix socket outside the sandbox, in a directory only the operator's user can open. The sandbox sees that directory read-only. The proxy admits HTTPS tunnels (`CONNECT host:443`) only to the listed hosts. Anything else gets 403, as does any request that is not a tunnel.
- Inside the sandbox, a forwarder from the same file listens on loopback, passes each connection to the socket, and then runs the CLI. The CLI gets the proxy in `HTTPS_PROXY` and the usual variants, and in `NODE_USE_ENV_PROXY` for node's own fetch. A CLI that ignores those variables reaches nothing.
- Every tunnel asked for is logged with its time, host, port and whether it was admitted. The log is kept with each exchange (and in `--proxy-log`), so a replay can show what it reached and what it was refused.

Usage, added to the sandbox adapter's flags:

```sh
node decision-map/prompt-command.mjs --hide <dir>... [--readable <dir>]... [--writable <dir>]... \
  --allow-host <host>... [--deny-host <host>]... [--proxy-log <file>] [--probe | --canary | ...] -- <cli> [args...]
```

`--allow-host` takes a host name, or `*.domain` for a domain's subdomains (not the domain itself). The node that runs the adapter also runs the forwarder inside the sandbox, so its install and the libraries it loads must be in the system or readable directories, like the CLI's own install.

### Proof before a run

- `--probe` checks the boundary from inside the sandbox as well as the files: a direct connection to two public addresses fails; each `--deny-host` (`github.com` by default) is refused by the proxy; each allowed host is admitted. A boundary that blocks everything fails the probe, because it would not let the stage reach its provider either.
- `--canary` has the model run one command through the full CLI, as in Phase 2. With network on, that command also tries each denied host with node's fetch and prints `BLOCKED` or `OPEN`. The canary fails on `OPEN` and when the line is missing.

The canary guards against a misconfigured command, not against a model that lies; the proxy log is the record of what was actually reached.

### Checked on the owner's machine (2026-10-26)

The probe passed: both direct connections failed with `ENETUNREACH`, `github.com` was refused, and the allowed host was admitted. The canary then passed for each provider the baseline run used, each with one allowed host. The CLIs also asked for other hosts, which the proxy refused:

| Provider (as the baseline run used it) | Allowed host | Refused, and the CLI still answered |
| --- | --- | --- |
| Codex, through the Development Cycle's bridge | `chatgpt.com` | `api.github.com`, `files.openai.com` |
| Claude Code CLI | `api.anthropic.com` | `mcp-proxy.anthropic.com` (remote connectors), a telemetry host |
| Command Code | `api.commandcode.ai` | `registry.npmjs.org` (update check) |

Two of the refused hosts are leak routes the boundary exists for: the Codex CLI asked for the GitHub API, and the Claude CLI asked for the proxy that carries its account's remote connectors, which can include GitHub. Both were refused, and the canary still passed.

### What the boundary does not cover

- A provider's own server-side tools (web search, say) run outside the sandbox. The harness will turn them off where the CLI allows it. Where it does not, the checkpoint records that as a known difference and the results say so.
- The agents' own commands run inside the same sandbox as the CLI, so they can reach the allowed provider hosts and nothing else. The roadmap asks for no network at all there. A CLI's own command sandbox can do that (Codex's does). Where none is used, it is a known difference.
- With `--sandbox-env`, the CLI's trusted start-up runs outside the sandbox, with the network. That start-up is the Development Cycle's Codex bridge, which reads the login and starts the app-server. The model and everything it runs are inside the sandbox.
- Host names are resolved outside the sandbox, by the proxy. Inside, there is no name resolution at all.
