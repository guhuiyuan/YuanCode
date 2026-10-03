---
title: Sandbox
description: Four sandbox modes — local / bubblewrap / docker / landlock — platform support, security model.
milestone: M7
audience: users, integrators, security reviewers
---

# Sandbox

Every `bash`, `write`, and `edit` tool call goes through a sandbox.
The sandbox has two jobs:

1. **Constrain** — keep the command inside `<cwd>` + user-approved extras
2. **Isolate** — prevent the command from seeing / touching the host
   filesystem, network, or processes (mode-dependent)

## Modes

YuanCode ships four modes. Pick one via `sandbox.mode` in `config.yaml`:

| Mode | Platform | Mechanism | Strength | Overhead |
|---|---|---|---|---|
| `local` (default) | all | `child_process.spawn` + `cwd` + env scrubbing + `PathGuard` | weak | ~0ms |
| `bubblewrap` | Linux | user-namespace + bind layout + PID + net isolation | medium | ~50ms |
| `docker` | all | `docker run --rm -i` with `--network none --memory 512m --cpus 1` | strong | ~500ms (cold), ~50ms (warm) |
| `landlock` | Linux 5.13+ + Node 22+ | kernel-level LSM ruleset, FS-only | strong | ~5ms |

### `local`

The cross-platform default. No OS-level isolation; just `PathGuard` and
`scrubEnv()`. The command runs in `<cwd>` with API keys, AWS creds,
SSH agent, etc. stripped from the env. Files outside `<cwd>` and the
forbidden patterns (`.ssh`, `.aws`, `/etc/passwd`, …) are blocked at the
application layer — sufficient for honest agents, not for adversarial
ones.

Use this when:

- You're on Windows or macOS and don't want to set up Docker
- You trust the agent (your own machine, local dev)
- You want zero startup overhead

### `bubblewrap`

Linux-only. Uses `bwrap` to create a fresh user namespace with a
curated bind layout:

```
/usr, /lib, /lib64, /etc, /bin, /sbin    → read-only
<cwd>                                      → /workspace (writable)
/tmp                                       → fresh tmpfs
/proc, /dev                                → pseudo
```

The child runs with:

- `--unshare-pid` — invisible to host process table
- `--unshare-net` — no outbound network (webfetch still works because it
  runs in the **parent** Node process, not inside the sandbox)
- `--unshare-ipc` — no shared memory with host
- `--die-with-parent` — no orphans if the agent crashes

Install: `apt install bubblewrap` (Debian/Ubuntu), `pacman -S bubblewrap`
(Arch). Healthcheck probes `bwrap --version`.

Use this when:

- You're on Linux
- You want real isolation without Docker's daemon dependency
- Cold-start latency under 100ms matters

### `docker`

Cross-platform. Wraps every command in:

```bash
docker run --rm -i \
  -v <cwd>:/workspace \
  -w /workspace \
  --network none \
  --memory 512m --cpus 1 \
  -e YUAN_INSIDE_SANDBOX=1 \
  <image> \
  /bin/sh -c <cmd>
```

Configurable knobs:

- `image` — default `yuancode/sandbox:latest`
- `network` — `none` (default), `host`, or `bridge`
- `memory` — default `512m`
- `cpus` — default `1`

The image (`bin/sandbox/Dockerfile`) ships Node + bash + coreutils + git
— enough for typical shell tasks. Build with:

```bash
docker build -t yuancode/sandbox:latest bin/sandbox
```

Healthcheck probes `docker version --format '{{.Server.Version}}'`.

Use this when:

- You want identical sandbox behavior across Windows / macOS / Linux
- The host already has Docker Desktop / daemon running
- You need to constrain CPU + memory

### `landlock`

Linux 5.13+ + Node 22+ (`node:landlock` built-in module). The fastest of
the three isolation modes — ~5ms overhead because there's no child
process to spawn.

Landlock is a Linux Security Module that restricts the **calling
process's** filesystem access via a kernel-level ruleset:

```
allowedFs = [cwd, /usr, /lib, /etc, /bin, /dev, /proc, /sys, ...extras]
handledAccessFs = [read_file, write_file, read_dir, remove_*, make_*]
landlockRestrictSelf(ruleset)   // ← irreversible!
```

Once `landlockRestrictSelf` runs, neither the agent nor any spawned
child can access paths outside `allowedFs`. There is no network
restriction — landlock is FS-only.

Requirements:

- Linux kernel 5.13+ (Ubuntu 22.04+, Debian 12+, Fedora 35+)
- Node 22+ with `node:landlock` available (Node 24.13.0 doesn't ship it
  yet — see [troubleshooting](#troubleshooting) below)

Use this when:

- You're on a recent Linux + Node 22
- You want minimal overhead with strong FS isolation
- You don't need network restrictions

## Configuration

```yaml
# ~/.yuancode/config.yaml
sandbox:
  mode: docker            # local | bubblewrap | docker | landlock
  image: yuancode/sandbox:latest   # docker only
  network: none                     # docker only: none | host | bridge
  memory: 512m                      # docker only
  cpus: 1                           # docker only
  extraWritable:                    # all modes
    - /tmp/scratch
```

## PathGuard

Every mode applies the same `PathGuard` (see
[src/core/sandbox/path-guard.ts](../src/core/sandbox/path-guard.ts)):

- `allow` — inside `<cwd>` or any `extraWritable`
- `readOnly` — `~/.yuancode/sandbox/system` (built-in toolchain)
- `forbidden` — matches `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`,
  `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `C:\Windows\System32`,
  `/proc/<pid>/{environ,mem,cmdline,…}`

Forbidden patterns **always win** over the cwd allow-list — even if
the file is technically inside `<cwd>`.

## Env scrubbing

All four modes apply `scrubEnv()` before spawning. Stripped keys:

```
API_KEY, *_API_KEY, SECRET, *_SECRET, TOKEN, *_TOKEN,
PASSWORD, PASSWD, AWS_*_ACCESS_KEY, AZURE_*, GCP_*,
GOOGLE_APPLICATION_CREDENTIALS, SSH_AGENT, SSH_IDENTITY,
GPG_*, YUANCODE_API_KEY
```

Strip happens on the **outer** env (parent process env). The child can
re-inject specific keys via `opts.env` if needed (rare).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bubblewrap sandbox requires Linux; detected <plat>` | not on Linux | use `local` or `docker` |
| `docker CLI not found on PATH` | no docker | install Docker Desktop / docker-ce |
| `docker daemon is not responding` | docker not running | start Docker Desktop |
| `landlock unavailable (need Node 22+ and Linux 5.13+)` | old runtime | upgrade Node to 22+ on a recent kernel |
| `landlock requires Linux; detected <plat>` | not on Linux | use `local`, `bubblewrap`, or `docker` |
| `Path is blocked by sandbox policy` | hit a forbidden pattern | use a path inside `<cwd>` or `extraWritable` |

## Healthchecks

Every mode exposes `healthcheck()` returning `null` on success or a
human-readable error string. The CLI runs all mode healthchecks at boot
and shows them in the TUI banner.

```ts
const sb = createSandbox({ mode: 'docker', cwd: process.cwd() })
const err = await sb.healthcheck()
if (err) console.warn(`sandbox unavailable: ${err}`)
```

## Security model

The four modes form a spectrum:

```
local  →  bubblewrap  →  landlock  →  docker
weak          medium          strong       strongest
(no OS)    (user NS)      (kernel LSM)   (full container)
```

`local` is a defense-in-depth layer, not a security boundary. It stops
accidental writes (the agent typo'd a path) and accidental secret leaks
(API keys stripped from env), but a determined attacker inside the
agent process has the same privileges as the agent.

`docker` is the strongest because the container has its own filesystem,
PID namespace, network namespace, and resource limits. A compromise
inside the container can't reach the host.

`bubblewrap` and `landlock` are strong on the filesystem axis but don't
isolate as completely as docker — `bubblewrap` doesn't restrict syscalls
or capabilities; `landlock` is FS-only and doesn't restrict network.

For high-trust workloads (CI, multi-tenant), use `docker`. For local
development on a single-user machine, `local` or `bubblewrap` is fine.