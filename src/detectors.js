'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function latestFile(root, accept, depth = 4) {
  let best;
  function walk(dir, remaining) {
    if (remaining < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, remaining - 1);
      else if (accept(full)) {
        try {
          const stat = fs.statSync(full);
          if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch { /* file disappeared */ }
      }
    }
  }
  walk(root, depth);
  return best;
}

let processCache;
async function processSnapshot(now = Date.now()) {
  if (processCache && now - processCache.sampledAt < 5000) return processCache.value;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist.exe', ['/fo', 'csv', '/nh']);
      processCache = { sampledAt: now, value: stdout.toLowerCase() };
      return processCache.value;
    }
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'comm=']);
    processCache = { sampledAt: now, value: stdout.toLowerCase() };
    return processCache.value;
  } catch {
    processCache = { sampledAt: now, value: '' };
    return processCache.value;
  }
}

function inferPhase(filePath) {
  const name = path.basename(filePath || '').toLowerCase();
  if (name.includes('tool') || name.includes('ui_messages')) return 'tool';
  if (name.includes('conversation') || name.endsWith('.jsonl')) return 'working';
  return 'working';
}

function clinePhaseFromMessage(message) {
  if (!message || typeof message !== 'object') return 'working';
  const kind = String(message.ask || message.say || message.event || message.kind || message.status || message.phase || '').toLowerCase();
  if (/waiting_input|user_input/.test(kind)) return 'waiting_input';
  if (/^approval$|waiting_approval/.test(kind)) return 'approval';
  if (/^idle$/.test(kind)) return 'idle';
  if (/failed|fatal|error/.test(kind)) return 'failed';
  if (message.ask && /command|tool|browser|mcp|followup|approval|permission|api_req_failed|resume_task/.test(kind)) return 'approval';
  if (/api_req_started|api_request_started|request_start|sending/.test(kind)) return 'sending_model';
  if (/api_req_finished|response_complete|parsing/.test(kind)) return 'parsing';
  if ((message.partial && /text|response|message/.test(kind)) || /stream|receiving/.test(kind)) return 'receiving_model';
  if (/mcp_server_request|use_mcp|mcp/.test(kind)) return 'mcp';
  if (/browser/.test(kind)) return 'browser';
  if (/command|command_output|shell/.test(kind)) return 'command';
  if (/read_file|read|list_files/.test(kind)) return 'reading';
  if (/search|grep|find/.test(kind)) return 'searching';
  if (/write|edit|patch|replace/.test(kind)) return 'editing';
  if (/completion|completed|task_finished/.test(kind)) return 'completed';
  return message.partial ? 'receiving_model' : 'working';
}

function readStructuredTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return text.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    }
  } catch { return []; }
}

function readClineEventFile(filePath) {
  const records = readStructuredTail(filePath);
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const candidate = record?.message && typeof record.message === 'object' ? { ...record, ...record.message } : record;
    const phase = clinePhaseFromMessage(candidate);
    if (phase !== 'working') {
      return { phase, needsApproval: phase === 'approval' || phase === 'waiting_input', lastActivityAt: normalizeTimestamp(candidate.ts || candidate.timestamp || candidate.updated_at) || fs.statSync(filePath).mtimeMs, evidence: `Cline operation:${String(candidate.ask || candidate.say || candidate.event || candidate.kind || candidate.status || candidate.phase || phase)}` };
    }
  }
  return undefined;
}

function readClineSignal(filePath) {
  try {
    const messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const last = Array.isArray(messages) ? messages.at(-1) : undefined;
    if (!last) return undefined;
    const phase = clinePhaseFromMessage(last);
    return { phase, lastActivityAt: Number(last.ts) || fs.statSync(filePath).mtimeMs, needsApproval: phase === 'approval', evidence: `Cline ${last.type || 'event'}:${last.ask || last.say || 'activity'}` };
  } catch { return undefined; }
}

function normalizeTimestamp(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Date.parse(value) || 0;
}

function readClineDatabase(databasePath) {
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const available = new Set(database.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
    const wanted = ['session_id', 'pid', 'started_at', 'ended_at', 'status', 'interactive', 'is_subagent', 'updated_at', 'messages_path', 'transcript_path', 'hook_path'];
    const selected = wanted.filter(column => available.has(column));
    if (!selected.includes('status')) return undefined;
    const order = available.has('updated_at') ? 'updated_at' : available.has('started_at') ? 'started_at' : 'rowid';
    const row = database.prepare(`SELECT ${selected.join(', ')} FROM sessions ORDER BY ${order} DESC LIMIT 1`).get();
    if (!row) return undefined;
    const status = String(row.status || '').toLowerCase();
    const active = !row.ended_at && !/(idle|completed|cancelled|failed|error|stopped|ended)/.test(status);
    const needsApproval = /(approval|permission|waiting_user|input)/.test(status);
    const failed = /(failed|error|fatal)/.test(status);
    const cancelled = /(cancelled|canceled|stopped)/.test(status);
    let phase = 'undisclosed';
    if (status === 'idle') phase = 'idle';
    if (failed) phase = 'failed';
    else if (cancelled) phase = 'cancelled';
    else if (needsApproval) phase = 'approval';
    else if (/(model|llm|api|stream|thinking)/.test(status)) phase = 'model';
    else if (/(tool|command|shell|mcp|browser)/.test(status)) phase = 'tool';
    else if (/(completed|ended)/.test(status)) phase = 'completed';
    const eventPath = [row.messages_path, row.transcript_path, row.hook_path].find(candidate => candidate && fs.existsSync(candidate));
    const event = active && eventPath && readClineEventFile(eventPath);
    if (event) { phase = event.phase; }
    const lifecycleEvidence = status === 'idle'
      ? 'Cline session is idle and ready for a new prompt'
      : failed
        ? `Cline session ended with ${status}`
        : cancelled
          ? `Cline session was ${status}`
          : /(completed|ended)/.test(status)
            ? 'Cline session completed'
            : `Cline reports ${status || 'running'}, but does not publish the current operation`;
    return { phase, active, failed, cancelled, terminalOutcome: failed ? 'failed' : cancelled ? 'cancelled' : /(completed|ended)/.test(status) ? 'completed' : undefined, needsApproval: event?.needsApproval ?? needsApproval, processAlive: active, lastActivityAt: event?.lastActivityAt || normalizeTimestamp(row.updated_at || row.started_at), evidence: event?.evidence || lifecycleEvidence, evidenceSource: event ? 'hook' : 'lifecycle', confidence: event ? 'observed' : 'verified', liveEvidence: Boolean(event), sessionId: String(row.session_id || '').slice(0, 12) };
  } catch { return undefined; }
  finally { try { database?.close(); } catch { /* already closed */ } }
}

function claudePhaseFromRecord(record) {
  if (!record || typeof record !== 'object') return 'working';
  const content = Array.isArray(record.message?.content) ? record.message.content : [];
  const blocks = content.map(item => String(item?.type || '')).filter(Boolean);
  if (blocks.includes('tool_use')) return 'tool';
  if (blocks.includes('tool_result')) return 'working';
  if (record.type === 'assistant') return 'model';
  return 'working';
}

function readClaudeSignal(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(lines[i]);
        if (!['assistant', 'user'].includes(record.type)) continue;
        return { phase: claudePhaseFromRecord(record), lastActivityAt: Date.parse(record.timestamp) || fs.statSync(filePath).mtimeMs, evidence: `Claude ${record.type} event` };
      } catch { /* partial or malformed JSONL record */ }
    }
  } catch { /* unreadable file */ }
  return undefined;
}

function currentClineLifecycle(previous, current) {
  if (!current?.terminalOutcome) return current;
  const observedTransition = previous && previous.sessionId === current.sessionId && previous.active;
  if (observedTransition) return current;
  return { ...current, phase: 'idle', active: false, failed: false, cancelled: false, needsApproval: false, evidence: `No active Cline session · previous session ended with ${current.terminalOutcome}` };
}

let previousClineDatabaseSignal;
let seenCompanionActivityAt;
async function detectAgents(workspacePaths = []) {
  const home = os.homedir();
  const processes = await processSnapshot();
  const candidates = [];
  let companionSignal;
  for (const workspacePath of workspacePaths) {
    const eventPaths = [
      path.join(workspacePath, '.cline', 'agent-runtime-lens-events.jsonl'),
      // Read-only migration fallback for workspaces that enabled the pre-rename observer.
      path.join(workspacePath, '.cline', 'agent-pulse-events.jsonl')
    ];
    for (const eventPath of eventPaths) {
      const event = readClineEventFile(eventPath);
      if (event && (!companionSignal || event.lastActivityAt > companionSignal.lastActivityAt)) companionSignal = event;
    }
  }
  if (companionSignal) {
    const age = Date.now() - companionSignal.lastActivityAt;
    const terminal = ['completed', 'failed', 'idle'].includes(companionSignal.phase);
    if (age > (terminal ? 120000 : 15 * 60000)) companionSignal = undefined;
  }
  if (companionSignal) {
    const terminal = ['completed', 'failed', 'idle'].includes(companionSignal.phase);
    const newlyObserved = seenCompanionActivityAt != null && companionSignal.lastActivityAt > seenCompanionActivityAt;
    seenCompanionActivityAt = Math.max(seenCompanionActivityAt || 0, companionSignal.lastActivityAt || 0);
    const historicalFailure = companionSignal.phase === 'failed' && !newlyObserved;
    candidates.push({ id: 'cline', name: 'Cline', ...companionSignal, phase: historicalFailure ? 'idle' : companionSignal.phase, active: !terminal, processAlive: true, failed: companionSignal.phase === 'failed' && newlyObserved, confidence: 'verified', liveEvidence: true, evidenceSource: 'hook', evidence: historicalFailure ? 'No active Cline session · previous observer run ended with failed' : companionSignal.evidence });
  }
  const clineHome = process.env.CLINE_DIR || path.join(home, '.cline');
  const databaseSignal = companionSignal ? undefined : readClineDatabase(path.join(clineHome, 'data', 'db', 'sessions.db'));
  if (databaseSignal) {
    candidates.push({ id: 'cline', name: 'Cline', ...currentClineLifecycle(previousClineDatabaseSignal, databaseSignal) });
    previousClineDatabaseSignal = databaseSignal;
  }
  const appData = process.env.APPDATA;
  const clineRoots = [
    path.join(clineHome, 'data', 'tasks'),
    appData && path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
  ].filter(Boolean);
  for (const root of databaseSignal ? [] : clineRoots) {
    const latest = latestFile(root, p => /ui_messages\.json$/i.test(p));
    if (latest) {
      const signal = readClineSignal(latest.path) || {};
      candidates.push({ id: 'cline', name: 'Cline', phase: signal.phase || inferPhase(latest.path), active: Date.now() - (signal.lastActivityAt || latest.mtimeMs) < 10 * 60_000, processAlive: true, processEvidenceVerified: false, lastActivityAt: signal.lastActivityAt || latest.mtimeMs, needsApproval: signal.needsApproval, evidence: signal.evidence || `Recent Cline state file (${path.basename(latest.path)})`, evidenceSource: 'inferred', confidence: 'observed' });
      break;
    }
  }
  const claudeRoot = path.join(home, '.claude');
  const latestClaude = latestFile(claudeRoot, p => p.endsWith('.jsonl') || /tool-results/i.test(p));
  const claudeAlive = processes.includes('claude');
  if (latestClaude || claudeAlive) {
    const signal = latestClaude && readClaudeSignal(latestClaude.path);
    const recentEvidence = Boolean(latestClaude && Date.now() - (signal?.lastActivityAt || latestClaude.mtimeMs) < 10 * 60_000);
    candidates.push({ id: 'claude', name: 'Claude', phase: signal?.phase || inferPhase(latestClaude?.path), active: claudeAlive || recentEvidence, processAlive: claudeAlive || recentEvidence, processEvidenceVerified: claudeAlive, lastActivityAt: signal?.lastActivityAt || latestClaude?.mtimeMs || Date.now(), evidence: signal?.evidence || (latestClaude ? `Recent Claude evidence (${path.basename(latestClaude.path)})` : 'Claude process detected'), evidenceSource: signal ? 'hook' : 'inferred', confidence: 'observed' });
  }
  return candidates;
}

let previousCpu = os.cpus();
let previousCgroupCpu;
function cpuPercent() {
  const current = os.cpus();
  let idle = 0, total = 0;
  current.forEach((cpu, i) => {
    const old = previousCpu[i]?.times || cpu.times;
    const delta = Object.fromEntries(Object.keys(cpu.times).map(k => [k, cpu.times[k] - old[k]]));
    idle += delta.idle;
    total += Object.values(delta).reduce((a, b) => a + b, 0);
  });
  previousCpu = current;
  return total ? Math.round(100 * (1 - idle / total)) : 0;
}

function readNumber(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value || value === 'max') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function cgroupMetrics(now = Date.now(), root = '/sys/fs/cgroup') {
  if (process.platform !== 'linux' && root === '/sys/fs/cgroup') return undefined;
  const memoryCurrent = readNumber(path.join(root, 'memory.current')) ?? readNumber(path.join(root, 'memory', 'memory.usage_in_bytes'));
  const memoryMax = readNumber(path.join(root, 'memory.max')) ?? readNumber(path.join(root, 'memory', 'memory.limit_in_bytes'));
  let quota, period;
  try {
    const parts = fs.readFileSync(path.join(root, 'cpu.max'), 'utf8').trim().split(/\s+/);
    quota = parts[0] === 'max' ? undefined : Number(parts[0]);
    period = Number(parts[1]);
  } catch {
    quota = readNumber(path.join(root, 'cpu', 'cpu.cfs_quota_us'));
    period = readNumber(path.join(root, 'cpu', 'cpu.cfs_period_us'));
  }
  let usageUsec;
  try {
    const stat = fs.readFileSync(path.join(root, 'cpu.stat'), 'utf8');
    const match = stat.match(/(?:^|\n)usage_usec\s+(\d+)/);
    usageUsec = match ? Number(match[1]) : undefined;
  } catch {
    const usageNs = readNumber(path.join(root, 'cpuacct', 'cpuacct.usage'));
    usageUsec = usageNs == null ? undefined : usageNs / 1000;
  }
  let allocatedCpuCores = quota && period && quota > 0 ? quota / period : undefined;
  let containerCpuPercent;
  if (usageUsec != null && allocatedCpuCores && previousCgroupCpu && now > previousCgroupCpu.at) {
    const capacityUsec = (now - previousCgroupCpu.at) * 1000 * allocatedCpuCores;
    containerCpuPercent = Math.round(100 * Math.max(0, usageUsec - previousCgroupCpu.usageUsec) / capacityUsec);
  }
  if (usageUsec != null) previousCgroupCpu = { at: now, usageUsec };
  const plausibleMemoryLimit = memoryMax && memoryMax < os.totalmem() * 0.99;
  const explicitContainer = Boolean(process.env.KUBERNETES_SERVICE_HOST || process.env.REMOTE_CONTAINERS || process.env.CODESPACES);
  if (!plausibleMemoryLimit && !allocatedCpuCores && !explicitContainer) return undefined;
  return {
    resourceScope: process.env.KUBERNETES_SERVICE_HOST ? 'kubernetes-pod' : 'container',
    allocatedCpuCores,
    cpuPercent: containerCpuPercent,
    totalMemoryBytes: plausibleMemoryLimit ? memoryMax : undefined,
    freeMemoryBytes: plausibleMemoryLimit ? Math.max(0, memoryMax - (memoryCurrent || 0)) : undefined,
    memoryPercent: plausibleMemoryLimit ? Math.round(100 * (memoryCurrent || 0) / memoryMax) : undefined
  };
}

let networkCache;
async function networkProbe(now = Date.now()) {
  if (networkCache && now - networkCache.sampledAt < 5000) return networkCache;
  const start = Date.now();
  let timeout;
  try {
    await Promise.race([dns.lookup('api.anthropic.com'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 2500); })]);
    networkCache = { network: 'online', networkLatencyMs: Date.now() - start, networkProbeKind: 'dns', sampledAt: now };
  } catch {
    networkCache = { network: 'offline', networkLatencyMs: Date.now() - start, networkProbeKind: 'dns', sampledAt: now };
  } finally { clearTimeout(timeout); }
  return networkCache;
}

function selectMostConstrainedDisk(paths) {
  const candidates = [];
  for (const target of paths) {
    try {
      const stat = fs.statfsSync(target);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      candidates.push({ diskPath: target, diskTotalBytes: totalBytes, diskFreeBytes: freeBytes, diskFreePercent: totalBytes ? Math.round(100 * freeBytes / totalBytes) : undefined });
    } catch { /* target disappeared or filesystem is unavailable */ }
  }
  return candidates.sort((a, b) => (a.diskFreePercent ?? 101) - (b.diskFreePercent ?? 101))[0] || {};
}

async function sampleHost(workspacePath = os.homedir()) {
  const hostTotal = os.totalmem();
  const container = cgroupMetrics();
  const total = container?.totalMemoryBytes || hostTotal;
  const free = container?.freeMemoryBytes ?? os.freemem();
  const memoryPercent = container?.memoryPercent ?? (total ? Math.round(100 * (1 - free / total)) : 0);
  const targets = Array.isArray(workspacePath)
    ? (workspacePath.length ? workspacePath : [os.homedir()])
    : [workspacePath || os.homedir()];
  const disk = selectMostConstrainedDisk(targets);
  return { hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, resourceScope: container?.resourceScope || 'host', allocatedCpuCores: container?.allocatedCpuCores, cpuPercent: container?.cpuPercent ?? cpuPercent(), memoryPercent, totalMemoryBytes: total, freeMemoryBytes: free, ...disk, ...(await networkProbe()), sampledAt: Date.now() };
}

let windowsPeerCache;
async function sampleWindowsPeerFromWsl(now = Date.now()) {
  if (process.platform !== 'linux' || !/microsoft/i.test(os.release())) return undefined;
  if (windowsPeerCache && now - windowsPeerCache.sampledAt < 15_000) return windowsPeerCache;
  const script = [
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$cpu=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average",
    "$drive=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$env:SystemDrive'\"",
    "$sw=[Diagnostics.Stopwatch]::StartNew()",
    "try{[Net.Dns]::GetHostAddresses('api.anthropic.com')|Out-Null;$net='online'}catch{$net='offline'}",
    "$sw.Stop()",
    "[ordered]@{hostname=$env:COMPUTERNAME;cpuPercent=[math]::Round($cpu);totalMemoryBytes=[double]$os.TotalVisibleMemorySize*1024;freeMemoryBytes=[double]$os.FreePhysicalMemory*1024;diskTotalBytes=[double]$drive.Size;diskFreeBytes=[double]$drive.FreeSpace;network=$net;networkLatencyMs=$sw.ElapsedMilliseconds}|ConvertTo-Json -Compress"
  ].join(';');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, maxBuffer: 64 * 1024 });
    const data = JSON.parse(stdout.trim());
    const total = Number(data.totalMemoryBytes);
    const free = Number(data.freeMemoryBytes);
    const diskTotal = Number(data.diskTotalBytes);
    const diskFree = Number(data.diskFreeBytes);
    windowsPeerCache = { ...data, resourceScope: 'windows-host', peer: true, memoryPercent: total ? Math.round(100 * (1 - free / total)) : undefined, diskFreePercent: diskTotal ? Math.round(100 * diskFree / diskTotal) : undefined, sampledAt: now };
    return windowsPeerCache;
  } catch {
    windowsPeerCache = { resourceScope: 'windows-host', peer: true, unavailable: true, sampledAt: now };
    return windowsPeerCache;
  }
}

module.exports = { latestFile, inferPhase, clinePhaseFromMessage, readClineEventFile, claudePhaseFromRecord, normalizeTimestamp, readClineSignal, readClineDatabase, currentClineLifecycle, readClaudeSignal, detectAgents, cpuPercent, cgroupMetrics, selectMostConstrainedDisk, sampleHost, sampleWindowsPeerFromWsl };
