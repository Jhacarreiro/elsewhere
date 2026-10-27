# Isolated replay (Phase 3 step 3)

**Status:** in progress. The network boundary and the harness are built and checked on the owner's machine with probes and a stage that runs no model. Nothing here has replayed a stage with a model yet.

A replay runs one stage again from an adequate [checkpoint](CHECKPOINT_RECORD.md). It must not see what happened after the decision, through files or through the network. Files are handled by the [sandbox adapter](../decision-map/prompt-command.mjs) from Phase 2: the run, the adapter's state and anything written later are hidden, and the CLI sees only system directories and the ones named readable or writable. This page covers the network.

## Network boundary

The run's repository host, its pull requests and issues, the project's wiki and any other live source can all show what happened after the decision. So the stage may reach its model providers and nothing else.

- The sandbox gets no network of its own (`bwrap --unshare-net`), only a loopback interface. A direct connection to any outside address fails.
- Its one way out is an allowlist proxy, [`decision-map/net-allow.mjs`](../decision-map/net-allow.mjs). It listens on a unix socket outside the sandbox, in a directory only the operator's user can open. The sandbox sees that directory read-only. The proxy admits HTTPS tunnels (`CONNECT host:443`) only to the listed hosts. Anything else gets 403, as does any request that is not a tunnel.
- The name in the CONNECT request alone does not fix where an encrypted tunnel ends up. A provider behind a shared HTTPS edge would route a TLS ClientHello that names another site to that site. So nothing the client sends goes on until the proxy has read the server name in its ClientHello and found it is the host the tunnel was admitted for. A hello that names another host, names none, offers Encrypted Client Hello (which hides the real name) or is not TLS closes the tunnel, and the log records why.
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
- The proxy sees the TLS server name, not the HTTP request inside the encrypted tunnel. An edge that routed by the encrypted `Host` header rather than the server name could still be used to reach another site behind it; whether that works depends on the provider's edge, not on the proxy.

## Harness

[`decision-map/replay.mjs`](../decision-map/replay.mjs) runs one stage again from an adequate [checkpoint bundle](CHECKPOINT_RECORD.md#builder):

```sh
node decision-map/replay.mjs --bundle <dir> --repository <git-dir> --spec <spec.json> --out <dir> \
  [--run <dir>] [--adapter <dir>] [--change <change.json>] (--cgroup <dir> | --no-limits) [--probe]
```

- **Bundle.** The harness recomputes the checkpoint's adequacy and checks every copy against the hash the record gives. An inadequate checkpoint or a changed copy is refused.
- **Fresh copies,** under `--out`, which must be outside the repository and the run and adapter roots. `worktree/` is a new repository that holds the checkpoint's commit and its history, fetched by id. It has no remote and no refs, so no later commit, tag or branch is in it. `run/` and `adapter/` hold the checkpoint's inputs at their pointers and nothing else. `home/` starts empty. The repository is only read from.
- **Original paths.** The stage's prompt and configuration name the paths the run used (its project checkout, its run directory, the adapter's state directory, its home). The spec mounts each copy at the path it replaces, so those recorded inputs stay byte for byte as they were. The sandbox is the [sandbox adapter's](../decision-map/prompt-command.mjs): system directories and the spec's readable ones, read-only; the spec's hidden directories empty; the copies over them.
- **Environment.** The variables the run recorded (`env`) are set inside the sandbox only. bwrap is found and started with the operator's own variables and the provider logins the spec names (`pass_env`), so a recorded `PATH` or loader variable cannot choose or alter the sandbox itself.
- **Network.** A replay always runs behind the [network boundary](#network-boundary). A spec without provider hosts is refused.
- **Branch.** A control replays the checkpoint unchanged. A branch adds one recorded change (`--change`), a file replaced or appended to in the run or adapter copy before the stage starts. The record keeps the change's hashes before and after.
- **Record.** `replay.json` holds the checkpoint, commit, branch, command, the names of the variables the stage got, the sandbox, the start, end and duration, the exit status, the output's size, the disk space used, the proxy's counts, and the known differences, the checkpoint's own plus the spec's. The stage's output and the proxy's log are kept in `logs/`. A second replay into the same directory is refused.
- **Output.** The stage's output goes to its logs through the harness, which counts it. Past `max_output_bytes` (64 MiB by default, both streams together) the rest is dropped, the stage is stopped as on a timeout, and the record says the output was cut. A replay that timed out or was cut fails.
- **Disk.** What the stage writes to its copies and its home lands on the operator's disk too. The harness checks the free space where `--out` is every second, and stops the stage once it has used more than `max_write_bytes` of it (16 GiB by default) or less than `min_free_bytes` is left (2 GiB). The record gives the space used and whether the stage was stopped for it, and such a replay fails. A fast writer can pass the limit within that second, so for a stage you do not trust, put `--out` on a filesystem with its own size and inode quota. The checkout of the checkpoint's commit happens before the stage, so its size is checked first from the commit's tree: a commit whose files would take more than `max_write_bytes`, number more than `max_files` (a million by default) or leave less than `min_free_bytes` free is refused before anything is written.
- **Resource limits.** The stage runs in a cgroup of its own, made under the one passed with `--cgroup` (a cgroup v2 directory delegated to the operator, giving its children the `pids`, `memory` and `cpu` controllers). It caps the stage's processes, memory (with no swap) and CPU, by default 4096 processes, 8 GiB and 2 CPUs, or the spec's `limits`. A stage that reaches its memory or process limit is stopped, the record names the limit, and the replay fails. Without `--cgroup` a replay is refused unless the operator passes `--no-limits`, which the record keeps as a known difference.
- **Git.** The worktree is laid out on the host, before the sandbox and the proxy exist, so git runs without the operator's system and global configuration and without any `GIT_` variables. A filter or hook named there (Git LFS, say) cannot act on what the commit asks for.
- **Probe.** `--probe` runs the sandbox adapter's probe with the same mounts and boundary instead of the stage.

The spec:

```json
{
  "command": ["<the stage's argv, as the run recorded it>"],
  "env": { "SETTING": "as the run recorded it" },
  "pass_env": ["PROVIDER_LOGIN_VARIABLE"],
  "home": "/original/home",
  "mounts": [
    { "at": "/original/runs/project", "from": "run", "writable": true },
    { "at": "/original/adapter-state/worktrees/<run>/integration", "from": "worktree", "writable": true },
    { "at": "/original/adapter-state", "from": "adapter", "writable": true }
  ],
  "hide": ["/original/runs", "/original/wiki"],
  "readable": ["/where/the/clis/are/installed"],
  "allow_hosts": ["provider.example"],
  "timeout_seconds": 14400,
  "max_output_bytes": 67108864,
  "max_write_bytes": 17179869184,
  "min_free_bytes": 2147483648,
  "max_files": 1000000,
  "limits": { "pids": 4096, "memory_bytes": 8589934592, "cpus": 2 },
  "known_differences": [{ "subject": "adapter version", "recorded": null, "replay": "...", "note": "..." }]
}
```

### Checked on the owner's machine (2026-10-27)

On the baseline run's adequate checkpoint, the start of the implementation pass, with the run's own paths mounted:

- The probe passed. The hidden directories were empty, the root read-only, and the copies and the fresh home writable. Direct connections failed, `github.com` was refused, and the three providers' hosts were admitted.
- A stage that runs no model listed what it could see. The run directory held only the checkpoint's six run inputs. The previous run's delivery record was not there, though its id is what names the commit. The project checkout was at the checkpoint's commit with no refs at all. The adapter's state held only its routing configuration.

### Before the first replay with a model

These are open, and step 4 cannot start until each is either solved or recorded as a known difference:

- **The project wiki.** It was one of the stage's read roots, and it is a git repository too. The checkpoint holds one repository commit today, so the wiki is hidden. Either the checkpoint names a second commit (the wiki as it was before the decision), or its absence is a known difference.
- **Provider logins.** Each CLI needs its login inside the sandbox. That means a fresh configuration directory holding only the credential, not the operator's own, which keeps other sessions' history. The Codex bridge reads its login from the agent runtime's state, which the sandbox hides.
- **Resource limits on the owner's machine.** The agent runtime's container sees its cgroups read-only, so `--cgroup` has nothing to use there yet. The container needs a cgroup delegated to it (a writable cgroup namespace or a delegated systemd scope), which means changing and recreating it, or the replay runs with `--no-limits` and says so.
- **Recorded configuration that no longer exists.** The recorded `PATH` names a plugin build that has since been replaced. The runner's lifecycle hook reports to local services the sandbox cannot reach. The adapter has been upgraded since the run.
