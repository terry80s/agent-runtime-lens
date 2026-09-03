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
- Shows separate, color-coded CPU, memory, disk-free, and network indicators directly in the status bar; no opaque composite score is required.
- Keeps every numeric status-bar field in a stable character slot, so latency changes such as `9ms` to `112ms` do not make neighboring items jump.
- Uses the normal VS Code foreground for healthy values, blue for user attention, yellow/red only for verified warnings, and a gray slashed icon when a metric is unavailable.
- Detects recent Cline and Claude Code activity using read-only local evidence.
- Samples CPU, available memory, and a bounded network/DNS probe.
- Uses cgroup v2/v1 CPU and memory limits inside Kubernetes Pods and Dev Containers, so percentages are relative to the assigned resources rather than the Linux node.
- Explains whether the Agent or host currently needs attention.
- Exports a redacted JSON diagnostic snapshot without prompts, responses, or source code.
- Provides a native-theme dashboard with a rolling Agent/CPU/memory/disk/network timeline.
- Provides an Agent Flight Recorder that merges repeated samples into readable stages with duration and evidence-source badges; the raw evidence table remains available in a collapsed section.
- Uses a rich status-bar hover to expose the current Agent stage, duration, evidence source, and both current/peer resource boundaries without requiring a click.
- Adds a tiny built-in Reload Window rescue button beside the monitor. It invokes VS Code's own command directly, which is useful when an Agent or remote extension host stops responding.
- Stabilizes warnings with immediate escalation and three-sample recovery, reports short trends, marks stale evidence, and uses a five-sample network median while retaining the latest raw latency in the tooltip.
- Prevents overlapping samples, clears stale status items after a failed cycle, caches expensive process/DNS/Windows-peer probes, and never lets an older live event overwrite newer lifecycle evidence.
- Supports cgroup v1/v2, unbounded host cgroups, empty Remote-SSH windows, and multi-root workspaces (the most constrained workspace filesystem is shown).
- Offers a `minimal` status-bar mode and an optional Reload Window rescue button. Dashboard refreshes preserve raw-timeline disclosure and scroll state.
- Parses Cline semantic fields and Claude Code block types without reading message text.
- Supports Cline 4.1.x's `~/.cline/data/db/sessions.db` lifecycle metadata with patch-version schema discovery, including remote/container installations, without selecting prompt content.
- Consumes Cline SDK/runtime events when the installed build exposes a subscription, mapping approval/input, model request/stream, tool/read/search/edit/command/MCP/browser, completion, cancellation, and failure states.
- In WSL, labels the current metrics as WSL and samples a cached Windows-host summary through WSL interop. The dashboard shows both resource boundaries; the healthy state stays quiet as `WSL · WIN`, while warning/error/unavailable icons appear only when attention is needed.
- Never labels event silence as slow or stalled unless the data source explicitly reports a failure; missing operation telemetry remains gray and is explained.

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
