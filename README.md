# Agent Runtime Lens

Agent-first status and diagnostics for Cline, Claude Code, and the host running them.

## Agent support

| Agent | Detection | Live operation stages |
| --- | --- | --- |
| Cline 4.1.x | Supported | SDK/runtime events when exposed; workspace hook and lifecycle fallbacks |
| Claude Code | Supported | JSONL/hook evidence available to the current execution environment |
| GitHub Copilot | Installed-state only | Not available: Copilot session hooks are private proposed VS Code APIs |

Agent Runtime Lens shows an installed Copilot as a compact gray `Copilot` status item instead of `No agent`. The visibility limitation stays in the hover/dashboard. It does not infer private activity from CPU or process fluctuations.

## What the MVP does

- Shows the most important Agent state in the VS Code status bar.
- Shows separate CPU, memory, disk, and network facts directly in the status bar; no opaque composite score is required.
- Keeps every numeric status-bar field in a stable character slot, so latency changes such as `9ms` to `112ms` do not make neighboring items jump.
- Uses only the current VS Code theme foreground. An empty circle means idle; a slashed circle means the observation is unavailable. The extension does not recolor the status bar to judge severity.
- Detects recent Cline and Claude Code activity using read-only local evidence.
- Samples CPU, available memory, and a bounded network/DNS probe.
- Resolves the process's nested cgroup v2/v1 path inside Kubernetes Pods and Dev Containers, so CPU and memory are relative to the assigned resources rather than the Linux node.
- Reports observations and evidence without inferring that a quiet Agent or an unreachable public endpoint is stuck.
- Exports a redacted JSON diagnostic snapshot without prompts, responses, or source code.
- Provides a native-theme dashboard with a rolling Agent/CPU/memory/disk/network timeline.
- Provides an Agent Flight Recorder that merges repeated samples into readable stages with duration and evidence-source badges; the raw evidence table remains available in a collapsed section.
- Uses a rich status-bar hover to expose the current Agent stage, duration, evidence source, and both current/peer resource boundaries without requiring a click.
- Adds a tiny built-in Reload Window rescue button beside the monitor. It invokes VS Code's own command directly, which is useful when an Agent or remote extension host stops responding.
- Reports short trends, marks stale evidence, and uses a five-sample network median while retaining the latest raw latency in the tooltip.
- Prevents overlapping samples, clears stale status items after a failed cycle, caches expensive process/DNS/Windows-peer probes, and never lets an older live event overwrite newer lifecycle evidence.
- Supports cgroup v1/v2, unbounded host cgroups, empty Remote-SSH windows, and multi-root workspaces (the most constrained workspace filesystem is shown).
- Offers a `minimal` status-bar mode and an optional Reload Window rescue button. Dashboard refreshes preserve raw-timeline disclosure and scroll state.
- Parses Cline semantic fields and Claude Code block types without reading message text.
- Supports Cline 4.1.x's `~/.cline/data/db/sessions.db` lifecycle metadata with patch-version schema discovery, including remote/container installations, without selecting prompt content.
- Consumes Cline SDK/runtime events when the installed build exposes a subscription, mapping approval/input, model request/stream, tool/read/search/edit/command/MCP/browser, completion, cancellation, and failure states.
- In WSL, labels the current metrics as WSL and samples a cached Windows-host summary through WSL interop. The dashboard shows both resource boundaries using the active VS Code theme.
- Never labels event silence as slow or stalled unless the data source explicitly reports a failure; missing operation telemetry is shown as unavailable and explained.

## Run locally

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

Commands:

- `Agent Runtime Lens: Show Current Status`
- `Agent Runtime Lens: Is It Stuck?`
- `Agent Runtime Lens: Open Dashboard`
- `Agent Runtime Lens: Enable Cline Deep Visibility` installs a workspace-local, metadata-only Cline observer plugin. Start a new Cline session after enabling it.
- `Agent Runtime Lens: Export Diagnostics`
- `Agent Runtime Lens: Refresh Now`

## Test

```sh
npm test
npm run check
```

## Evidence levels and limits

Cline 4.1.x builds do not all expose the same public extension API. Agent Runtime Lens therefore negotiates capabilities: live SDK/runtime events first, the metadata-only workspace observer second, and lifecycle database evidence last. The UI says `step undisclosed` when Cline proves that a session is running but publishes no current operation; it does not invent `slow` or `stalled`. Windows peer sampling is available from WSL. Other remote transports cannot inspect the UI host without a separately running UI-side companion and are shown as unavailable.

## Pod and network semantics

In Remote-SSH, the extension runs where the VS Code extension host runs. If that host is inside a Pod, Agent Runtime Lens reads `/proc/self/cgroup` and the matching nested cgroup files. CPU and memory therefore describe the Pod/container allocation when limits exist. If no finite limit exists, it does not invent one.

Disk free is obtained from the filesystem containing the workspace. Kubernetes `ephemeral-storage` limits are not exposed through CPU/memory cgroups. To display that separate allocation, inject it with the Downward API:

```yaml
env:
  - name: AGENT_RUNTIME_LENS_EPHEMERAL_STORAGE_LIMIT
    valueFrom:
      resourceFieldRef:
        resource: limits.ephemeral-storage
        divisor: "1"
```

The network indicator is a bounded DNS reachability measurement against several public Agent/service endpoints, not a general connectivity verdict. If all tested public names are blocked by corporate DNS, a proxy, or network policy, it displays unavailable/unknown—never offline. Internal connectivity can still be fully functional.

A reproducible k3s Remote-SSH Pod fixture is provided in [`e2e/k3s`](e2e/k3s). It uses a public-key Secret and intentionally contains no password or private key.
