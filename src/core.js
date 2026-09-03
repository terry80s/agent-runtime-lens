'use strict';

const STATES = Object.freeze({
  IDLE: 'idle', WORKING: 'working', READING: 'reading', EDITING: 'editing',
  TOOL: 'tool', MODEL: 'model', APPROVAL: 'approval', COMPLETED: 'completed',
  SLOW: 'slow', STALLED: 'stalled', FAILED: 'failed', CANCELLED: 'cancelled', UNKNOWN: 'unknown'
});

const SEVERITY = Object.freeze({ green: 0, gray: 1, blue: 2, yellow: 3, red: 4 });

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function formatCapacity(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return undefined;
  const value = Number(bytes);
  const gib = value / 1073741824;
  if (gib >= 1024) return `${Number((gib / 1024).toFixed(1))}T`;
  if (gib >= 10) return `${Math.round(gib)}G`;
  if (gib >= 1) return `${Number(gib.toFixed(1))}G`;
  const mib = value / 1048576;
  return `${Math.max(0, Math.round(mib))}M`;
}

const FIGURE_SPACE = '\u2007';
function fixedSlot(value, width) {
  const text = String(value);
  return text.length >= width ? text : FIGURE_SPACE.repeat(width - text.length) + text;
}

function formatLatency(milliseconds) {
  if (milliseconds == null || !Number.isFinite(Number(milliseconds)) || Number(milliseconds) < 0) return fixedSlot('—', 5);
  const value = Number(milliseconds);
  if (value >= 1000) return fixedSlot(`${Math.min(99, Math.round(value / 100) / 10)}s`, 5);
  return fixedSlot(`${Math.round(value)}ms`, 5);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function trend(values, tolerance = 2) {
  const usable = values.filter(Number.isFinite);
  if (usable.length < 2) return 'steady';
  const delta = usable.at(-1) - usable[0];
  return delta > tolerance ? 'up' : delta < -tolerance ? 'down' : 'steady';
}

function stabilizeColor(previous, observed, recoverySamples = 3) {
  if (!previous) return { color: observed, recoveryCount: 0 };
  const previousSeverity = SEVERITY[previous.color] ?? 0;
  const observedSeverity = SEVERITY[observed] ?? 0;
  if (observedSeverity >= previousSeverity) return { color: observed, recoveryCount: 0 };
  const recoveryCount = (previous.recoveryCount || 0) + 1;
  return recoveryCount >= recoverySamples ? { color: observed, recoveryCount: 0 } : { color: previous.color, recoveryCount };
}

function dataFreshness(sampledAt, now = Date.now(), staleAfterMs = 15000) {
  if (!sampledAt || now - sampledAt > staleAfterMs) return 'stale';
  return 'fresh';
}

function evidenceQuality(source) {
  return ({ live: { label: 'Live', level: 4 }, hook: { label: 'Hook', level: 3 }, lifecycle: { label: 'Lifecycle', level: 2 }, inferred: { label: 'Inferred', level: 1 } })[source] || { label: 'Observed', level: 1 };
}

function dominantColor(...colors) {
  return colors.filter(Boolean).sort((a, b) => (SEVERITY[b] ?? 0) - (SEVERITY[a] ?? 0))[0] || 'gray';
}

function shouldUseLiveObservation(live, persisted, now = Date.now()) {
  if (!live || !Number.isFinite(live.lastActivityAt)) return false;
  if (Number.isFinite(persisted?.lastActivityAt) && persisted.lastActivityAt > live.lastActivityAt) return false;
  const terminal = live.failed || live.active === false || ['completed', 'cancelled', 'idle', 'failed'].includes(live.phase);
  return now - live.lastActivityAt <= (terminal ? 120000 : 30 * 60000);
}

function environmentKind(remoteName, resourceScope) {
  if (resourceScope === 'kubernetes-pod') return { short: 'POD', title: 'Pod allocation', icon: 'cloud', remote: true };
  if (remoteName === 'wsl') return { short: 'WSL', title: 'WSL environment', icon: 'cloud', remote: true };
  if (remoteName === 'ssh-remote') return { short: 'SSH', title: 'Remote SSH host', icon: 'cloud', remote: true };
  if (remoteName === 'dev-container' || remoteName === 'attached-container') return { short: 'DEV', title: 'Dev Container allocation', icon: 'cloud', remote: true };
  if (resourceScope === 'container') return { short: 'CTR', title: 'Container allocation', icon: 'cloud', remote: true };
  if (remoteName) return { short: 'REMOTE', title: `Remote environment (${remoteName})`, icon: 'cloud', remote: true };
  return { short: 'LOCAL', title: 'Local host', icon: 'device-desktop', remote: false };
}

function hostHealth(metrics) {
  let score = 100;
  const reasons = [];
  const cpu = metrics.cpuPercent ?? 0;
  const memory = metrics.memoryPercent ?? 0;
  const diskFree = metrics.diskFreePercent;
  const freeMemory = metrics.freeMemoryBytes;
  const diskFreeBytes = metrics.diskFreeBytes;
  if (cpu >= 95) { score -= 30; reasons.push('CPU is saturated'); }
  else if (cpu >= 85) { score -= 15; reasons.push('CPU is under pressure'); }
  if (memory >= 95) { score -= 35; reasons.push('Memory is nearly exhausted'); }
  else if (memory >= 85) { score -= 18; reasons.push('Available memory is low'); }
  else if (freeMemory != null && freeMemory < 128 * 1048576) { score -= 35; reasons.push('Less than 128M memory is available'); }
  else if (freeMemory != null && freeMemory < 256 * 1048576) { score -= 18; reasons.push('Less than 256M memory is available'); }
  if (diskFree != null && diskFree <= 3) { score -= 40; reasons.push('Storage is nearly full'); }
  else if (diskFree != null && diskFree <= 10) { score -= 18; reasons.push('Storage is running low'); }
  else if (diskFreeBytes != null && diskFreeBytes < 1024 ** 3) { score -= 40; reasons.push('Less than 1G storage is free'); }
  else if (diskFreeBytes != null && diskFreeBytes < 5 * 1024 ** 3) { score -= 18; reasons.push('Less than 5G storage is free'); }
  if (metrics.network === 'offline') { score -= 50; reasons.push('Network check failed'); }
  else if ((metrics.networkLatencyMs ?? 0) >= 1000) { score -= 20; reasons.push('Network latency is high'); }
  score = clamp(score, 0, 100);
  return { score, color: score < 40 ? 'red' : score < 75 ? 'yellow' : 'green', reasons };
}

function metricStatus(kind, value, extra = {}) {
  if (kind === 'cpu' || kind === 'memory') {
    if (!Number.isFinite(value)) return 'gray';
    if (kind === 'memory' && extra.freeMemoryBytes != null) {
      if (extra.freeMemoryBytes < 128 * 1048576) return 'red';
      if (extra.freeMemoryBytes < 256 * 1048576) return 'yellow';
    }
    return value >= 95 ? 'red' : value >= 85 ? 'yellow' : 'green';
  }
  if (kind === 'disk') {
    if (!Number.isFinite(value)) return 'gray';
    if (extra.diskFreeBytes != null && extra.diskFreeBytes < 1024 ** 3) return 'red';
    if (extra.diskFreeBytes != null && extra.diskFreeBytes < 5 * 1024 ** 3) return 'yellow';
    return value <= 3 ? 'red' : value <= 10 ? 'yellow' : 'green';
  }
  if (kind === 'network') {
    if (extra.network === 'offline') return 'red';
    if (!Number.isFinite(value) || value < 0) return 'gray';
    return value >= 2000 ? 'red' : value >= 300 ? 'yellow' : 'green';
  }
  return 'gray';
}

function classifyAgent(observation, now = Date.now(), slowThresholdMs = 45000, failureAttentionMs = 120000) {
  if (!observation) return { state: STATES.IDLE, color: 'gray', label: 'No agent', confidence: 'observed' };
  const observedAt = Number.isFinite(observation.lastActivityAt) ? observation.lastActivityAt : now;
  const age = Math.max(0, now - observedAt);
  if (observation.unsupportedTelemetry) return { ...observation, state: STATES.UNKNOWN, color: 'gray', label: 'Activity unavailable', shortLabel: 'Limited', statusLabel: observation.id === 'copilot' ? 'Copilot' : observation.name, age };
  if (observation.failed && age <= failureAttentionMs) return { ...observation, state: STATES.FAILED, color: 'red', label: 'Failed', age };
  if (observation.failed) return { ...observation, active: false, state: STATES.IDLE, color: 'gray', label: 'Idle', age, evidence: `Previous session failed ${formatAge(age)} ago; no session is active` };
  if (observation.cancelled || observation.phase === 'cancelled') return { ...observation, state: STATES.CANCELLED, color: 'gray', label: 'Cancelled', age };
  if (observation.phase === 'waiting_input') return { ...observation, state: STATES.APPROVAL, color: 'blue', label: 'Waiting for your input', shortLabel: 'Waiting', age };
  if (observation.needsApproval) return { ...observation, state: STATES.APPROVAL, color: 'blue', label: 'Waiting for approval', shortLabel: 'Waiting', age };
  if (observation.visibilityLimited) return { ...observation, state: STATES.UNKNOWN, color: 'gray', label: 'Activity unavailable', shortLabel: '—', age };
  if (observation.phase === 'completed' && age < 10 * 60_000) return { ...observation, state: STATES.COMPLETED, color: 'green', label: 'Done', age };
  if (!observation.active) return { ...observation, state: STATES.IDLE, color: 'gray', label: 'Idle', age };
  if (observation.processAlive === false && observation.processEvidenceVerified && observation.active) return { ...observation, state: STATES.FAILED, color: 'red', label: 'Process exited', shortLabel: 'Exited', age };
  if (observation.phase === 'sending_model' && observation.liveEvidence && age >= 2000) {
    return { ...observation, state: STATES.MODEL, phase: 'waiting_model', color: 'green', label: 'Waiting for LLM', shortLabel: 'LLM…', age, confidence: 'inferred' };
  }
  if (observation.phase === 'undisclosed' || observation.phase === 'working') {
    return { ...observation, state: STATES.UNKNOWN, color: 'gray', label: 'Running · step undisclosed', shortLabel: 'Active', age };
  }
  const labels = { preparing_context: 'Preparing context', reading: 'Reading files', searching: 'Searching', editing: 'Editing files', tool: 'Running tool', command: 'Running command', mcp: 'Calling MCP', browser: 'Using browser', sending_model: 'Sending to LLM', waiting_model: 'Waiting for LLM', receiving_model: 'Receiving LLM', parsing: 'Parsing response', model: 'LLM request', completed: 'Done' };
  const shortLabels = { preparing_context: 'Preparing', reading: 'Reading', searching: 'Searching', editing: 'Editing', tool: 'Tool', command: 'Command', mcp: 'MCP', browser: 'Browser', sending_model: 'Sending', waiting_model: 'LLM…', receiving_model: 'Receiving', parsing: 'Parsing', model: 'LLM…', completed: 'Done' };
  const state = labels[observation.phase] ? observation.phase : STATES.WORKING;
  const prefix = observation.liveEvidence === false && age >= slowThresholdMs ? 'Last seen: ' : '';
  return { ...observation, state, color: observation.liveEvidence === false ? 'gray' : 'green', label: `${prefix}${labels[state] || 'Running · step undisclosed'}`, shortLabel: shortLabels[state] || 'Active', age };
}

function formatAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function agentPriority(agent) {
  if (!agent) return -1;
  if (agent.state === STATES.APPROVAL || agent.color === 'blue') return 70;
  if (agent.state === STATES.FAILED || agent.color === 'red') return 60;
  if (agent.active && agent.state !== STATES.UNKNOWN) return 50;
  if (agent.active) return 40;
  if (agent.state === STATES.COMPLETED) return 30;
  if (agent.state === STATES.IDLE || agent.state === STATES.CANCELLED) return 20;
  if (agent.visibilityLimited) return 10;
  if (agent.unsupportedTelemetry) return 5;
  return agent.color === 'green' ? 50 : agent.color === 'yellow' ? 45 : 8;
}

function choosePrimary(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return undefined;
  return [...agents].sort((a, b) => agentPriority(b) - agentPriority(a) || ((Number(b?.lastActivityAt) || 0) - (Number(a?.lastActivityAt) || 0)))[0];
}

function agentStatusIcon(agent) {
  if (!agent) return 'circle-slash';
  if (agent.state === STATES.IDLE) return 'circle-outline';
  if (agent.visibilityLimited || agent.unsupportedTelemetry) return 'circle-slash';
  if (agent.state === STATES.UNKNOWN && agent.active) return 'circle-outline';
  return agent.color === 'gray' ? 'circle-slash' : 'circle-filled';
}

function agentStatusText(agent, mode = 'text') {
  const icon = `$(${agentStatusIcon(agent)})`;
  const state = agent?.shortLabel || agent?.label || 'None';
  return mode === 'compact' ? `${icon} ${state}` : `${icon} Agent: ${state}`;
}

function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED_TOKEN]')
      .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/([A-Z]:\\Users\\)[^\\/]+/gi, '$1[user]')
      .replace(/(\/home\/)[^/]+/g, '$1[user]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (/^hostname$/i.test(k)) return [k, '[REDACTED_HOST]'];
    if (/^sessionId$/i.test(k)) return [k, '[REDACTED_SESSION]'];
    if (/^(diskPath|cwd|workspaceRoot|workspace_root)$/i.test(k)) return [k, '[REDACTED_PATH]'];
    return [k, redact(v)];
  }));
  return value;
}

module.exports = { STATES, hostHealth, metricStatus, formatCapacity, fixedSlot, formatLatency, median, trend, stabilizeColor, dataFreshness, evidenceQuality, dominantColor, shouldUseLiveObservation, environmentKind, classifyAgent, agentPriority, choosePrimary, agentStatusIcon, agentStatusText, redact };
