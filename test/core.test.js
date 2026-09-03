'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hostHealth, metricStatus, formatCapacity, fixedSlot, formatLatency, median, trend, stabilizeColor, dataFreshness, evidenceQuality, dominantColor, shouldUseLiveObservation, environmentKind, classifyAgent, choosePrimary, redact } = require('../src/core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { clinePhaseFromMessage, readClineEventFile, claudePhaseFromRecord, cgroupMetrics, readClineDatabase, currentClineLifecycle, selectMostConstrainedDisk } = require('../src/detectors');
const { phaseFromClineEvent, createClineApiAdapter } = require('../src/cline-api');

test('healthy host is green', () => {
  assert.deepEqual(hostHealth({ cpuPercent: 30, memoryPercent: 40, diskFreePercent: 70, network: 'online', networkLatencyMs: 20 }), { score: 100, color: 'green', reasons: [] });
});

test('resource exhaustion is red with explanations', () => {
  const result = hostHealth({ cpuPercent: 98, memoryPercent: 97, diskFreePercent: 2, network: 'online' });
  assert.equal(result.color, 'red');
  assert.ok(result.reasons.length >= 3);
});

test('small remote allocations use absolute memory and disk safety floors', () => {
  assert.equal(metricStatus('memory', 70, { freeMemoryBytes: 100 * 1048576 }), 'red');
  assert.equal(metricStatus('memory', 70, { freeMemoryBytes: 200 * 1048576 }), 'yellow');
  assert.equal(metricStatus('disk', 30, { diskFreeBytes: 700 * 1048576 }), 'red');
  assert.equal(hostHealth({ cpuPercent: 10, memoryPercent: 70, freeMemoryBytes: 100 * 1048576, diskFreePercent: 30, diskFreeBytes: 700 * 1048576, network: 'online' }).color, 'red');
});

test('individual resource indicators have independent colors', () => {
  assert.equal(metricStatus('cpu', 96), 'red');
  assert.equal(metricStatus('memory', 87), 'yellow');
  assert.equal(metricStatus('disk', 65), 'green');
  assert.equal(metricStatus('network', 450, { network: 'online' }), 'yellow');
  assert.equal(metricStatus('network', 12, { network: 'offline' }), 'red');
});

test('capacities use compact human-readable units', () => {
  assert.equal(formatCapacity(16 * 1073741824), '16G');
  assert.equal(formatCapacity(4.6 * 1073741824), '4.6G');
  assert.equal(formatCapacity(768 * 1048576), '768M');
  assert.equal(formatCapacity(undefined), undefined);
  assert.equal(formatCapacity(2 * 1024 ** 4), '2T');
});

test('fixed slots never destroy significant digits', () => {
  assert.equal(fixedSlot('1024G free', 9), '1024G free');
});

test('status metrics occupy stable character slots', () => {
  assert.equal(fixedSlot('9ms', 5).length, fixedSlot('112ms', 5).length);
  assert.equal(formatLatency(9).length, formatLatency(112).length);
  assert.equal(formatLatency(2200), '\u20072.2s');
});

test('network median rejects one distracting latency spike', () => {
  assert.equal(median([9, 10, 112, 11, 8]), 10);
});

test('resource trends ignore insignificant movement', () => {
  assert.equal(trend([20, 21, 22], 3), 'steady');
  assert.equal(trend([20, 24], 3), 'up');
  assert.equal(trend([24, 20], 3), 'down');
});

test('warnings escalate immediately but recover after stable samples', () => {
  let state = stabilizeColor({ color: 'green', recoveryCount: 0 }, 'red');
  assert.equal(state.color, 'red');
  state = stabilizeColor(state, 'green');
  assert.equal(state.color, 'red');
  state = stabilizeColor(state, 'green');
  assert.equal(state.color, 'red');
  state = stabilizeColor(state, 'green');
  assert.equal(state.color, 'green');
});

test('dominant status never lets a host warning hide an Agent failure', () => {
  assert.equal(dominantColor('yellow', 'red'), 'red');
  assert.equal(dominantColor('green', 'blue'), 'blue');
});

test('live terminal evidence expires and cannot overwrite newer persistence', () => {
  const live = { phase: 'completed', active: false, lastActivityAt: 1000 };
  assert.equal(shouldUseLiveObservation(live, undefined, 60000), true);
  assert.equal(shouldUseLiveObservation(live, undefined, 200000), false);
  assert.equal(shouldUseLiveObservation({ ...live, active: true, phase: 'reading' }, { lastActivityAt: 2000 }, 3000), false);
});

test('stale samples and evidence strength are explicit', () => {
  assert.equal(dataFreshness(1000, 2000, 2000), 'fresh');
  assert.equal(dataFreshness(1000, 4000, 2000), 'stale');
  assert.ok(evidenceQuality('live').level > evidenceQuality('lifecycle').level);
});

test('remote environments never masquerade as local', () => {
  assert.deepEqual(environmentKind(undefined, 'host'), { short: 'LOCAL', title: 'Local host', icon: 'device-desktop', remote: false });
  assert.deepEqual(environmentKind('ssh-remote', 'host'), { short: 'SSH', title: 'Remote SSH host', icon: 'cloud', remote: true });
  assert.deepEqual(environmentKind('wsl', 'host'), { short: 'WSL', title: 'WSL environment', icon: 'cloud', remote: true });
  assert.deepEqual(environmentKind('dev-container', 'container'), { short: 'DEV', title: 'Dev Container allocation', icon: 'cloud', remote: true });
  assert.deepEqual(environmentKind(undefined, 'container'), { short: 'CTR', title: 'Container allocation', icon: 'cloud', remote: true });
  assert.deepEqual(environmentKind(undefined, 'kubernetes-pod'), { short: 'POD', title: 'Pod allocation', icon: 'cloud', remote: true });
  assert.deepEqual(environmentKind('codespaces', 'host'), { short: 'REMOTE', title: 'Remote environment (codespaces)', icon: 'cloud', remote: true });
});

test('approval is blue and outranks inactivity', () => {
  const result = classifyAgent({ name: 'Cline', active: true, needsApproval: true, processAlive: true, lastActivityAt: 0 }, 1_000_000, 1000);
  assert.equal(result.color, 'blue');
  assert.equal(result.state, 'approval');
  assert.equal(result.label, 'Waiting for approval');
  assert.equal(result.shortLabel, 'Waiting');
});

test('input and model waits stay distinct while status labels remain compact', () => {
  const input = classifyAgent({ name: 'Cline', phase: 'waiting_input', active: true, processAlive: true, lastActivityAt: 1000 }, 2000);
  const model = classifyAgent({ name: 'Cline', phase: 'waiting_model', active: true, processAlive: true, lastActivityAt: 1000 }, 2000);
  assert.equal(input.label, 'Waiting for your input');
  assert.equal(input.shortLabel, 'Waiting');
  assert.equal(input.color, 'blue');
  assert.equal(model.label, 'Waiting for LLM');
  assert.equal(model.shortLabel, 'LLM…');
  assert.notEqual(model.color, 'blue');
  assert.equal(input.age, 1000);
});

test('all active phases have concise unambiguous status labels', () => {
  const expected = {
    preparing_context: 'Preparing', reading: 'Reading', searching: 'Searching', editing: 'Editing',
    tool: 'Tool', command: 'Command', mcp: 'MCP', browser: 'Browser', sending_model: 'Sending',
    waiting_model: 'LLM…', receiving_model: 'Receiving', parsing: 'Parsing', model: 'LLM…'
  };
  for (const [phase, shortLabel] of Object.entries(expected)) {
    const result = classifyAgent({ name: 'Cline', phase, active: true, processAlive: true, lastActivityAt: 1000 }, 2000);
    assert.equal(result.shortLabel, shortLabel, phase);
    assert.ok(result.label.length >= shortLabel.length, phase);
  }
});

test('missing and future activity timestamps never produce invalid ages', () => {
  const missing = classifyAgent({ name: 'Cline', phase: 'reading', active: true }, 2000);
  const future = classifyAgent({ name: 'Cline', phase: 'reading', active: true, lastActivityAt: 3000 }, 2000);
  assert.equal(missing.age, 0);
  assert.equal(future.age, 0);
  assert.ok(Number.isFinite(missing.age));
});

test('silence without a heartbeat contract never becomes a false stall', () => {
  const result = classifyAgent({ name: 'Cline', phase: 'undisclosed', active: true, processAlive: true, lastActivityAt: 0, confidence: 'verified' }, 400000, 1000);
  assert.equal(result.color, 'gray');
  assert.equal(result.label, 'Running · step undisclosed');
  assert.equal(result.shortLabel, 'Active');
});

test('old persisted evidence is idle rather than working', () => {
  const result = classifyAgent({ name: 'Cline', active: false, processAlive: false, lastActivityAt: 0 }, 4000, 1000);
  assert.equal(result.color, 'gray');
  assert.equal(result.state, 'idle');
});

test('unverified process absence never creates a false process-exited failure', () => {
  const result = classifyAgent({ name: 'Claude', phase: 'reading', active: true, processAlive: false, processEvidenceVerified: false, lastActivityAt: 1000 }, 2000);
  assert.notEqual(result.label, 'Process exited');
  assert.notEqual(result.color, 'red');
});

test('verified process exit remains a failure', () => {
  const result = classifyAgent({ name: 'Claude', phase: 'reading', active: true, processAlive: false, processEvidenceVerified: true, lastActivityAt: 1000 }, 2000);
  assert.equal(result.label, 'Process exited');
  assert.equal(result.color, 'red');
});

test('installed agent without live evidence reports limited visibility', () => {
  const result = classifyAgent({ name: 'Cline', active: false, visibilityLimited: true, lastActivityAt: 0 }, 4000, 1000);
  assert.equal(result.color, 'gray');
  assert.equal(result.label, 'Limited visibility');
});

test('installed Copilot is visible without inventing private activity', () => {
  const result = classifyAgent({ id: 'copilot', name: 'GitHub Copilot', unsupportedTelemetry: true, active: false, lastActivityAt: 0, evidenceSource: 'inferred' }, 4000);
  assert.equal(result.label, 'Activity unavailable');
  assert.equal(result.statusLabel, 'Copilot');
  assert.equal(result.color, 'gray');
  assert.equal(result.state, 'unknown');
});

test('installed-only Copilot does not hide a supported Agent', () => {
  const primary = choosePrimary([
    { name: 'GitHub Copilot', unsupportedTelemetry: true, color: 'gray', lastActivityAt: 2000 },
    { name: 'Cline', color: 'gray', lastActivityAt: 1000 }
  ]);
  assert.equal(primary.name, 'Cline');
});

test('primary agent is the one requiring most attention', () => {
  assert.equal(choosePrimary([{ name: 'Cline', color: 'green', lastActivityAt: 2 }, { name: 'Claude', color: 'red', lastActivityAt: 1 }]).name, 'Claude');
  assert.equal(choosePrimary([]), undefined);
  assert.equal(choosePrimary(undefined), undefined);
  assert.equal(choosePrimary([{ name: 'Unknown' }, { name: 'Cline', color: 'yellow' }]).name, 'Cline');
});

test('diagnostic export redacts secrets and home usernames', () => {
  const output = redact({ token: 'token=abc123456789', path: 'C:\\Users\\rukun\\project', key: 'sk-abcdefghijk12345' });
  assert.doesNotMatch(JSON.stringify(output), /rukun|abc123456789|sk-abcdefghijk12345/);
});

test('diagnostic export redacts host and session identifiers by key', () => {
  const result = redact({ hostname: 'private-host', sessionId: 'private-session', diskPath: '/private/work', nested: { hostname: 'other-host' } });
  assert.equal(result.hostname, '[REDACTED_HOST]');
  assert.equal(result.sessionId, '[REDACTED_SESSION]');
  assert.equal(result.nested.hostname, '[REDACTED_HOST]');
  assert.equal(result.diskPath, '[REDACTED_PATH]');
});

test('Cline semantic fields map phases without reading message text', () => {
  assert.equal(clinePhaseFromMessage({ type: 'say', say: 'api_req_started', text: 'secret prompt' }), 'sending_model');
  assert.equal(clinePhaseFromMessage({ type: 'say', say: 'command' }), 'command');
  assert.equal(clinePhaseFromMessage({ type: 'ask', ask: 'followup' }), 'approval');
});

test('Cline event file chooses the latest meaningful operation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-events-'));
  const eventPath = path.join(root, 'messages.json');
  fs.writeFileSync(eventPath, JSON.stringify([{ ts: 1000, type: 'say', say: 'api_req_started', text: 'private' }, { ts: 2000, type: 'say', say: 'text', partial: true, text: 'private response' }]));
  const signal = readClineEventFile(eventPath);
  assert.equal(signal.phase, 'receiving_model');
  assert.doesNotMatch(signal.evidence, /private/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline event reader tolerates missing, malformed, and partially written files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-malformed-'));
  const eventPath = path.join(root, 'events.jsonl');
  assert.equal(readClineEventFile(path.join(root, 'missing.jsonl')), undefined);
  fs.writeFileSync(eventPath, '{incomplete json\n');
  assert.equal(readClineEventFile(eventPath), undefined);
  fs.appendFileSync(eventPath, JSON.stringify({ timestamp: 2000, phase: 'reading' }) + '\n');
  assert.equal(readClineEventFile(eventPath).phase, 'reading');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline companion events expose waiting for user input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-wait-'));
  const eventPath = path.join(root, 'events.jsonl');
  fs.writeFileSync(eventPath, JSON.stringify({ timestamp: 2000, type: 'agent_runtime_lens', phase: 'waiting_input' }) + '\n');
  const signal = readClineEventFile(eventPath);
  assert.equal(signal.phase, 'waiting_input');
  assert.equal(signal.needsApproval, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Claude block types map phases without inspecting block content', () => {
  assert.equal(claudePhaseFromRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { secret: true } }] } }), 'tool');
  assert.equal(claudePhaseFromRecord({ type: 'assistant', message: { content: [{ type: 'text', text: 'secret response' }] } }), 'model');
});

test('cgroup v2 memory is calculated against the container allocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-cgroup-'));
  fs.writeFileSync(path.join(root, 'memory.current'), '536870912');
  fs.writeFileSync(path.join(root, 'memory.max'), '1073741824');
  fs.writeFileSync(path.join(root, 'cpu.max'), '50000 100000');
  fs.writeFileSync(path.join(root, 'cpu.stat'), 'usage_usec 1000000\n');
  const result = cgroupMetrics(1000, root);
  assert.equal(result.memoryPercent, 50);
  assert.equal(result.totalMemoryBytes, 1073741824);
  assert.equal(result.allocatedCpuCores, 0.5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('host cgroup with no limits is not mislabeled as a container', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-host-cgroup-'));
  fs.writeFileSync(path.join(root, 'memory.current'), '536870912');
  fs.writeFileSync(path.join(root, 'memory.max'), 'max');
  fs.writeFileSync(path.join(root, 'cpu.max'), 'max 100000');
  fs.writeFileSync(path.join(root, 'cpu.stat'), 'usage_usec 1000000\n');
  assert.equal(cgroupMetrics(1000, root), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cgroup v1 limits are supported for older Kubernetes and SSH hosts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-cgroup-v1-'));
  for (const folder of ['memory', 'cpu', 'cpuacct']) fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, 'memory', 'memory.usage_in_bytes'), '536870912');
  fs.writeFileSync(path.join(root, 'memory', 'memory.limit_in_bytes'), '1073741824');
  fs.writeFileSync(path.join(root, 'cpu', 'cpu.cfs_quota_us'), '50000');
  fs.writeFileSync(path.join(root, 'cpu', 'cpu.cfs_period_us'), '100000');
  fs.writeFileSync(path.join(root, 'cpuacct', 'cpuacct.usage'), '1000000000');
  const result = cgroupMetrics(2000, root);
  assert.equal(result.totalMemoryBytes, 1073741824);
  assert.equal(result.allocatedCpuCores, 0.5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('multi-root disk selection chooses the most constrained filesystem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-disk-'));
  const result = selectMostConstrainedDisk([root, path.join(root, 'missing')]);
  assert.equal(result.diskPath, root);
  assert.ok(result.diskTotalBytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline 4 session database is read without selecting prompt content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-cline-'));
  const dbPath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, pid INTEGER, started_at INTEGER, ended_at INTEGER, status TEXT, interactive INTEGER, is_subagent INTEGER, updated_at INTEGER, prompt TEXT, messages_path TEXT, transcript_path TEXT, hook_path TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('session-secret-id', 42, 1000, null, 'waiting_for_approval', 1, 0, 2000, 'private prompt', null, null, null);
  db.close();
  const signal = readClineDatabase(dbPath);
  assert.equal(signal.phase, 'approval');
  assert.equal(signal.confidence, 'verified');
  assert.equal(signal.lastActivityAt, 2000000);
  assert.equal(Object.hasOwn(signal, 'prompt'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline database idle means waiting for a new prompt, not running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-idle-'));
  const dbPath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, pid INTEGER, started_at INTEGER, ended_at INTEGER, status TEXT, interactive INTEGER, is_subagent INTEGER, updated_at INTEGER, messages_path TEXT, transcript_path TEXT, hook_path TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('idle-session', 42, 1000, null, 'idle', 1, 0, 2000, null, null, null);
  db.close();
  const signal = readClineDatabase(dbPath);
  assert.equal(signal.phase, 'idle');
  assert.equal(signal.active, false);
  assert.equal(signal.evidence, 'Cline session is idle and ready for a new prompt');
  fs.rmSync(root, { recursive: true, force: true });
});

test('terminal Cline lifecycle cannot be overwritten by an old tool event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-terminal-event-'));
  const eventPath = path.join(root, 'events.jsonl');
  fs.writeFileSync(eventPath, JSON.stringify({ event: 'tool_started', timestamp: Date.now() }) + '\n');
  const dbPath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, started_at INTEGER, ended_at INTEGER, status TEXT, updated_at INTEGER, messages_path TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('idle-with-old-event', 1000, null, 'idle', 2000, eventPath);
  db.close();
  const signal = readClineDatabase(dbPath);
  assert.equal(signal.phase, 'idle');
  assert.equal(signal.evidenceSource, 'lifecycle');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline database failure remains failed instead of becoming idle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-failed-'));
  const dbPath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, started_at INTEGER, status TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('failed-session', 1000, 'failed');
  db.close();
  const signal = readClineDatabase(dbPath);
  const classified = classifyAgent({ name: 'Cline', ...signal }, 2000);
  assert.equal(signal.failed, true);
  assert.equal(signal.phase, 'failed');
  assert.equal(classified.label, 'Failed');
  assert.equal(classified.color, 'red');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an old Cline failure is history when no session is active', () => {
  const classified = classifyAgent({ name: 'Cline', phase: 'failed', failed: true, active: false, lastActivityAt: 1000 }, 301000);
  assert.equal(classified.label, 'Idle');
  assert.equal(classified.color, 'gray');
  assert.match(classified.evidence, /Previous session failed 5m ago/);
});

test('a newly reported Cline failure remains a red attention state', () => {
  const classified = classifyAgent({ name: 'Cline', phase: 'failed', failed: true, active: false, lastActivityAt: 1000 }, 61000);
  assert.equal(classified.label, 'Failed');
  assert.equal(classified.color, 'red');
});

test('persisted failure at extension startup is idle history', () => {
  const current = { sessionId: 's1', phase: 'failed', terminalOutcome: 'failed', failed: true, active: false, lastActivityAt: Date.now() };
  const result = currentClineLifecycle(undefined, current);
  assert.equal(result.phase, 'idle');
  assert.equal(result.failed, false);
  assert.match(result.evidence, /No active Cline session/);
});

test('running-to-failed transition observed during this runtime is current failure', () => {
  const previous = { sessionId: 's1', phase: 'undisclosed', active: true };
  const current = { sessionId: 's1', phase: 'failed', terminalOutcome: 'failed', failed: true, active: false };
  const result = currentClineLifecycle(previous, current);
  assert.equal(result.phase, 'failed');
  assert.equal(result.failed, true);
});

test('Cline cancellation is a neutral terminal state', () => {
  const classified = classifyAgent({ name: 'Cline', phase: 'cancelled', cancelled: true, active: false, lastActivityAt: 1000 }, 2000);
  assert.equal(classified.label, 'Cancelled');
  assert.equal(classified.color, 'gray');
});

test('Cline 4.1 database reader tolerates patch-version schema differences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-lens-cline-minimal-'));
  const dbPath = path.join(root, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (session_id TEXT, started_at INTEGER, status TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('minimal-session', 1000, 'completed');
  db.close();
  const signal = readClineDatabase(dbPath);
  assert.equal(signal.phase, 'completed');
  assert.equal(signal.active, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cline API distinguishes waiting for approval and waiting for input', () => {
  assert.equal(phaseFromClineEvent({ type: 'tool_approval_requested', payload: { text: 'private' } }).phase, 'approval');
  assert.equal(phaseFromClineEvent({ type: 'user_input_required', payload: { text: 'private' } }).phase, 'waiting_input');
});

test('Cline API distinguishes tool, model stream, and completion', () => {
  assert.equal(phaseFromClineEvent({ type: 'tool_started', payload: { name: 'read_file', input: 'private' } }).phase, 'reading');
  assert.equal(phaseFromClineEvent({ type: 'text_delta', payload: { text: 'private response' } }).phase, 'receiving_model');
  assert.equal(phaseFromClineEvent({ type: 'agent_done' }).phase, 'completed');
});

test('Cline SDK kebab-case runtime events map to useful states', () => {
  const live = phaseFromClineEvent({ type: 'assistant-text-delta' });
  assert.equal(live.phase, 'receiving_model');
  assert.equal(live.evidenceSource, 'live');
  assert.equal(phaseFromClineEvent({ type: 'reasoning-delta' }).phase, 'receiving_model');
  assert.equal(phaseFromClineEvent({ type: 'resumable' }).phase, 'waiting_input');
});

test('Cline API adapter handles unavailable APIs, alternate event hubs, and disposal', async () => {
  const inactive = createClineApiAdapter({ extensions: { getExtension: () => ({ isActive: false }) } }, () => {});
  assert.equal(await inactive.connect(), false);

  let listener;
  let disposed = false;
  const observations = [];
  const api = { hub: { onDidChangeTask(callback) { listener = callback; return { dispose() { disposed = true; } }; } } };
  const adapter = createClineApiAdapter({ extensions: { getExtension: () => ({ isActive: true, exports: api }) } }, value => observations.push(value));
  assert.equal(await adapter.connect(), true);
  assert.equal(await adapter.connect(), true);
  listener({ type: 'tool_started', payload: { name: 'read_file', secret: 'private' } });
  assert.equal(observations[0].phase, 'reading');
  assert.doesNotMatch(observations[0].evidence, /private/);
  assert.deepEqual(adapter.apiShape, ['hub']);
  adapter.dispose();
  assert.equal(disposed, true);
});

test('verified model request transitions to normal LLM wait without becoming slow', () => {
  const result = classifyAgent({ name: 'Cline', phase: 'sending_model', active: true, processAlive: true, liveEvidence: true, lastActivityAt: 1000, confidence: 'verified' }, 10000, 2000);
  assert.equal(result.label, 'Waiting for LLM');
  assert.equal(result.color, 'green');
});
