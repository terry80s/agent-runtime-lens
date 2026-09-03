'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hostHealth, metricStatus, formatCapacity, fixedSlot, formatLatency, median, trend, stabilizeColor, dataFreshness, evidenceQuality, dominantColor, shouldUseLiveObservation, environmentKind, classifyAgent, choosePrimary, redact } = require('./core');
const { detectAgents, sampleHost, sampleWindowsPeerFromWsl } = require('./detectors');
const { createClineApiAdapter } = require('./cline-api');

let snapshot = { agents: [], host: {}, health: { score: 100, color: 'green', reasons: [] }, sampledAt: 0 };
let statusItem;
let rescueItem;
const resourceItems = {};
let timer;
let dashboard;
let rawTimelineOpen = false;
let dashboardScrollY = 0;
const timeline = [];
let liveCline;
let clineApiAdapter;
let refreshing = false;
const networkSamples = [];
const displayColors = {};

const colors = {
  red: new vscode.ThemeColor('statusBarItem.errorBackground'),
  yellow: new vscode.ThemeColor('statusBarItem.warningBackground'),
  blue: new vscode.ThemeColor('statusBarItem.prominentBackground')
};
const foregroundColors = Object.fromEntries(['green', 'blue', 'yellow', 'red', 'gray'].map(name => [name, new vscode.ThemeColor(`agentRuntimeLens.status.${name}`)]));

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function diagnosis(primary, health) {
  if (!primary) return 'No supported Agent installation or activity was detected in this extension host.';
  if (primary.unsupportedTelemetry) return `${primary.name} is installed, but its private session telemetry is not available to Marketplace extensions.`;
  if (primary.visibilityLimited) return `${primary.name} is installed, but it exposes no live task evidence to this extension host.`;
  if (primary.color === 'blue') return `${primary.name} is waiting for your approval or input.`;
  if (primary.color === 'red' && health.color === 'red') return `${primary.name} reported a failure while the execution environment is unhealthy.`;
  if (primary.color === 'red') return `${primary.name} reported an explicit failure or its verified process exited.`;
  if (primary.phase === 'undisclosed' || primary.phase === 'working') return `${primary.name} reports that it is running, but does not expose its current operation. No slowdown or stall is inferred.`;
  if (health.color !== 'green') return `${primary.name} is progressing, but host pressure may slow the next operation.`;
  return `${primary.name} is progressing normally. The host and network checks are healthy.`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function evidenceLabel(agent) {
  return evidenceQuality(agent?.evidenceSource).label;
}

function trendLabel(direction, worseningUp = true) {
  if (direction === 'steady') return 'steady';
  const worse = worseningUp ? direction === 'up' : direction === 'down';
  return `${direction === 'up' ? 'rising' : 'falling'}${worse ? ' · watch' : ''}`;
}

function recentMetric(key, count = 5) {
  return timeline.slice(-count).map(point => point.host?.[key]).filter(Number.isFinite);
}

function metricSummary(host) {
  if (!host || host.unavailable) return 'Unavailable';
  const used = host.totalMemoryBytes != null && host.freeMemoryBytes != null ? formatCapacity(host.totalMemoryBytes - host.freeMemoryBytes) : '—';
  return `CPU ${host.cpuPercent ?? '—'}% · MEM ${used}/${formatCapacity(host.totalMemoryBytes) || '—'} · DISK ${formatCapacity(host.diskFreeBytes) || '—'} free · NET ${host.networkLatencyMs ?? '—'}ms`;
}

function hostCard(host, title, health = hostHealth(host)) {
  if (!host || host.unavailable) return `<section class="card"><h2><span class="dot gray"></span>${escapeHtml(title)}</h2><p>Unavailable from this extension host.</p></section>`;
  const used = host.totalMemoryBytes != null && host.freeMemoryBytes != null ? formatCapacity(host.totalMemoryBytes - host.freeMemoryBytes) : undefined;
  const total = formatCapacity(host.totalMemoryBytes);
  const diskFree = formatCapacity(host.diskFreeBytes);
  const diskTotal = formatCapacity(host.diskTotalBytes);
  const label = health.color === 'red' ? 'Critical' : health.color === 'yellow' ? 'Pressure' : 'Healthy';
  return `<section class="card"><h2><span class="dot ${health.color}"></span>${escapeHtml(title)} · ${label}</h2><div class="metrics"><div class="metric">CPU<br><b>${host.cpuPercent ?? '?'}%</b></div><div class="metric">Memory used<br><b>${used && total ? `${used}/${total}` : 'Unavailable'}</b></div><div class="metric">Disk free<br><b>${diskFree ? `${diskFree}${diskTotal ? ` of ${diskTotal}` : ''}` : 'Unavailable'}</b></div><div class="metric">Network<br><b>${host.networkLatencyMs ?? '?'}ms</b></div></div><p>${escapeHtml(health.reasons.length ? health.reasons.join(' · ') : 'No resource pressure detected')}</p></section>`;
}

function renderDashboard() {
  if (!dashboard) return;
  const primary = choosePrimary(snapshot.agents);
  const recent = timeline.slice(-60);
  const rows = [...recent].reverse().map(point => {
    const agent = choosePrimary(point.agents);
    return `<tr><td>${new Date(point.sampledAt).toLocaleTimeString()}</td><td><span class="dot ${agent?.color || 'gray'}"></span>${escapeHtml(agent ? `${agent.name}: ${agent.label}` : 'No agent')}</td><td><span class="badge">${escapeHtml(evidenceLabel(agent))}</span></td><td>${escapeHtml(agent?.evidence || '—')}</td><td>${point.host.cpuPercent ?? '?'}%</td><td>${point.host.memoryPercent ?? '?'}%</td><td>${point.host.diskFreePercent ?? '?'}%</td><td>${escapeHtml(point.host.network || 'unknown')} ${point.host.networkLatencyMs ?? '?'}ms</td></tr>`;
  }).join('');
  const segments = recent.reduce((result, point) => {
    const agent = choosePrimary(point.agents);
    if (!agent) return result;
    const previous = result.at(-1);
    const key = `${agent.name}|${agent.label}|${agent.evidenceSource}|${agent.color}`;
    if (previous?.key === key) previous.end = point.sampledAt;
    else result.push({ key, agent, start: point.sampledAt, end: point.sampledAt });
    return result;
  }, []);
  if (segments.length) segments.at(-1).end = snapshot.sampledAt;
  const flights = segments.slice(-12).map(segment => {
    const { agent } = segment;
    return `<div class="flight"><span class="rail ${agent.color}"></span><div><div class="flight-head"><b>${escapeHtml(agent.label)}</b><span>${new Date(segment.start).toLocaleTimeString()} · ${duration(Math.max(0, segment.end - segment.start))}</span></div><div><span class="badge">${escapeHtml(evidenceLabel(agent))}</span> ${escapeHtml(agent.evidence || 'No evidence')}</div></div></div>`;
  }).join('') || '<p>No meaningful Agent transitions recorded in this window.</p>';
  const agents = snapshot.agents.map(agent => `<section class="card"><h2><span class="dot ${agent.color}"></span>${escapeHtml(agent.name)} <span class="badge">${escapeHtml(evidenceLabel(agent))}</span></h2><div class="state">${escapeHtml(agent.label)}</div><p>${escapeHtml(agent.evidence || 'No evidence')}</p></section>`).join('') || '<section class="card"><h2>No active agent</h2><p>Cline and Claude Code history locations are monitored read-only.</p></section>';
  const currentTitle = environmentKind(snapshot.remoteName, snapshot.host.resourceScope).title;
  const peerCard = snapshot.peerHost ? hostCard(snapshot.peerHost, 'Windows host', snapshot.peerHealth) : '';
  const attention = primary?.color === 'red' || primary?.color === 'blue' || snapshot.health.color !== 'green';
  const visibilityLimited = primary?.unsupportedTelemetry || primary?.visibilityLimited || primary?.color === 'gray';
  const incident = attention ? `<section class="incident ${primary?.color === 'red' || snapshot.health.color === 'red' ? 'incident-red' : 'incident-warn'}"><b>Needs attention</b><div>${escapeHtml(diagnosis(primary, snapshot.health))}</div></section>` : visibilityLimited ? `<section class="quiet"><b>Environment clear · Agent visibility limited</b><div>${escapeHtml(diagnosis(primary, snapshot.health))}</div></section>` : '<section class="quiet"><b>All clear</b> · Agent and resource evidence show no current issue.</section>';
  const quality = evidenceQuality(primary?.evidenceSource);
  const nonce = crypto.randomBytes(16).toString('base64');
  dashboard.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:1300px;margin:auto}.titlebar{display:flex;align-items:center;justify-content:space-between;gap:12px}.actions{display:flex;gap:8px}.actions button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}.actions button:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.hero{font-size:18px;padding:14px;border-left:4px solid var(--vscode-focusBorder);background:var(--vscode-editor-inactiveSelectionBackground)}.incident,.quiet{padding:12px 14px;margin:12px 0}.incident{border-left:4px solid var(--vscode-editorWarning-foreground);background:var(--vscode-inputValidation-warningBackground)}.incident-red{border-color:var(--vscode-editorError-foreground);background:var(--vscode-inputValidation-errorBackground)}.quiet{border:1px solid var(--vscode-widget-border);color:var(--vscode-descriptionForeground)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin:16px 0}.card{border:1px solid var(--vscode-widget-border);padding:14px;background:var(--vscode-editor-background)}h1,h2{margin-top:0}.state{font-size:24px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}.metric{padding:10px;background:var(--vscode-textBlockQuote-background)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--vscode-widget-border)}details{margin-top:22px}.badge{font-size:11px;border:1px solid var(--vscode-widget-border);border-radius:9px;padding:1px 7px;color:var(--vscode-descriptionForeground);font-weight:normal}.trust{color:var(--vscode-descriptionForeground);margin-top:-8px}.flights{border:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background)}.flight{display:grid;grid-template-columns:5px 1fr;gap:12px;padding:12px 14px;border-bottom:1px solid var(--vscode-widget-border)}.flight:last-child{border-bottom:0}.rail{border-radius:3px}.flight-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:7px}.flight-head span{color:var(--vscode-descriptionForeground)}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}.green{background:var(--vscode-testing-iconPassed)}.blue{background:var(--vscode-charts-blue)}.yellow{background:var(--vscode-editorWarning-foreground)}.red{background:var(--vscode-editorError-foreground)}.gray{background:var(--vscode-descriptionForeground)}</style></head><body><div class="titlebar"><h1>Agent Runtime Lens</h1><div class="actions"><button aria-label="Export redacted diagnostics" data-action="export">Export</button><button aria-label="Reload VS Code Window" data-action="reload">Reload Window</button></div></div><div class="hero">${escapeHtml(diagnosis(primary, snapshot.health))}</div>${incident}<p class="trust">Evidence: ${escapeHtml(quality.label)} · trust ${quality.level}/4 · data ${escapeHtml(snapshot.freshness)}</p><div class="grid">${agents}${hostCard(snapshot.host, currentTitle, snapshot.health)}${peerCard}</div><h2>Agent Flight Recorder</h2><div class="flights">${flights}</div><details ${rawTimelineOpen ? 'open' : ''}><summary>Raw evidence timeline</summary><table><thead><tr><th>Time</th><th>Agent state</th><th>Source</th><th>Evidence</th><th>CPU</th><th>Memory</th><th>Disk free</th><th>Network</th></tr></thead><tbody>${rows}</tbody></table></details><script nonce="${nonce}">const vscode=acquireVsCodeApi();scrollTo(0,${Math.max(0, Math.round(dashboardScrollY))});document.querySelector('details').addEventListener('toggle',e=>vscode.postMessage({type:'rawOpen',value:e.target.open}));document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'action',value:button.dataset.action})));let pending;addEventListener('scroll',()=>{clearTimeout(pending);pending=setTimeout(()=>vscode.postMessage({type:'scroll',value:scrollY}),100)});</script></body></html>`;
}

function openDashboard() {
  if (!dashboard) {
    dashboard = vscode.window.createWebviewPanel('agentRuntimeLens.dashboard', 'Agent Runtime Lens', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    dashboard.onDidDispose(() => { dashboard = undefined; });
    dashboard.webview.onDidReceiveMessage(message => {
      if (message?.type === 'rawOpen') rawTimelineOpen = Boolean(message.value);
      if (message?.type === 'scroll' && Number.isFinite(message.value)) dashboardScrollY = Math.max(0, message.value);
      if (message?.type === 'action' && message.value === 'reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
      if (message?.type === 'action' && message.value === 'export') exportDiagnostics();
    });
  }
  dashboard.reveal();
  renderDashboard();
}

function updateStatus() {
  const primary = choosePrimary(snapshot.agents);
  const agentColor = primary?.state === 'idle' ? 'green' : primary?.color || 'gray';
  const dominant = dominantColor(snapshot.health.color, agentColor);
  const mode = vscode.workspace.getConfiguration('agentRuntimeLens').get('statusBarMode', 'text');
  const agentIcon = !primary ? '$(circle-slash)' : primary.state === 'idle' ? '$(circle-outline)' : primary.color === 'gray' ? '$(circle-slash)' : '$(circle-filled)';
  if (!primary) statusItem.text = mode === 'compact' ? `${agentIcon}` : `${agentIcon} No agent`;
  else if (primary.statusLabel) statusItem.text = `${agentIcon} ${primary.statusLabel}`;
  else {
    const conciseState = primary.shortLabel || primary.label;
    statusItem.text = mode === 'compact' ? `${agentIcon} ${conciseState}` : `${agentIcon} ${primary.name}: ${conciseState}`;
  }
  statusItem.color = dominant === 'green' ? undefined : foregroundColors[dominant];
  statusItem.backgroundColor = dominant === 'red' || dominant === 'yellow' ? colors[dominant] : undefined;
  const healthLabel = snapshot.health.color === 'red' ? 'Critical' : snapshot.health.color === 'yellow' ? 'Pressure' : 'Healthy';
  const environment = environmentKind(snapshot.remoteName, snapshot.host.resourceScope);
  const scope = environment.title;
  const agentAge = primary?.age != null ? duration(primary.age) : '—';
  const cpuTrend = trendLabel(trend(recentMetric('cpuPercent')));
  const memoryTrend = trendLabel(trend(recentMetric('memoryPercent')));
  const networkTrend = trendLabel(trend(recentMetric('networkLatencyMs'), 25));
  const peerLine = snapshot.peerHost ? `\n| Windows host | ${metricSummary(snapshot.peerHost)} |` : '';
  statusItem.tooltip = new vscode.MarkdownString(`**Agent Runtime Lens** · data ${snapshot.freshness}\n\n${diagnosis(primary, snapshot.health)}\n\n| Agent | State | Source | For |\n|---|---|---|---|\n| ${primary?.name || '—'} | ${primary?.label || 'No agent'} | ${evidenceLabel(primary)} | ${agentAge} |\n\n| Resource boundary | Current facts |\n|---|---|\n| ${scope} | ${metricSummary(snapshot.host)} |${peerLine}\n\nTrends: CPU ${cpuTrend} · memory ${memoryTrend} · network ${networkTrend}\n\nClick for Flight Recorder and raw evidence.`);
  statusItem.accessibilityInformation = { label: `Agent Runtime Lens. ${primary ? `${primary.name}, ${primary.label}` : 'No detected agent'}. Environment ${snapshot.health.color}.` };
  statusItem.show();
  const peerColor = snapshot.peerHost?.unavailable ? 'gray' : snapshot.peerHealth?.color || 'green';
  resourceItems.environment.text = `$(${environment.icon})`;
  resourceItems.environment.color = peerColor === 'green' ? undefined : foregroundColors[peerColor];
  resourceItems.environment.tooltip = snapshot.remoteName === 'wsl' ? 'Metrics shown: WSL execution environment\nWindows host is also sampled and shown in the dashboard.' : `Metrics shown: ${environment.title}`;
  resourceItems.environment.accessibilityInformation = { label: `Execution environment ${environment.title}` };
  resourceItems.environment.show();
  const memoryTotal = formatCapacity(snapshot.host.totalMemoryBytes);
  const memoryUsedBytes = snapshot.host.totalMemoryBytes != null && snapshot.host.freeMemoryBytes != null ? Math.max(0, snapshot.host.totalMemoryBytes - snapshot.host.freeMemoryBytes) : undefined;
  const memoryUsed = formatCapacity(memoryUsedBytes);
  const diskTotal = formatCapacity(snapshot.host.diskTotalBytes);
  const diskFree = formatCapacity(snapshot.host.diskFreeBytes);
  const resources = {
    cpu: { available: snapshot.host.cpuPercent != null, icon: '$(pulse)', text: `$(pulse) ${fixedSlot(`${snapshot.host.cpuPercent}%`, 4)}`, value: snapshot.host.cpuPercent, tooltip: `CPU usage · ${snapshot.host.cpuPercent}%\nCapacity · ${snapshot.host.allocatedCpuCores ? `${snapshot.host.allocatedCpuCores} allocated cores` : scope}` },
    memory: { available: Boolean(memoryUsed && memoryTotal), icon: '$(server-process)', text: `$(server-process) ${fixedSlot(`${memoryUsed}/${memoryTotal}`, 11)}`, value: snapshot.host.memoryPercent, tooltip: `Memory used · ${memoryUsed}\nMemory available · ${formatCapacity(snapshot.host.freeMemoryBytes) || 'unavailable'}\nMemory total · ${memoryTotal || 'unavailable'}\nUsage · ${snapshot.host.memoryPercent ?? 'unavailable'}%\nScope · ${scope}` },
    disk: { available: Boolean(diskFree && diskTotal), icon: '$(database)', text: `$(database) ${fixedSlot(`${diskFree} free`, 9)}`, value: snapshot.host.diskFreePercent, tooltip: `Disk free · ${diskFree || 'unavailable'}\nDisk used · ${formatCapacity(snapshot.host.diskTotalBytes - snapshot.host.diskFreeBytes) || 'unavailable'}\nDisk total · ${diskTotal || 'unavailable'}\nFree · ${snapshot.host.diskFreePercent ?? 'unavailable'}%\nScope · Workspace filesystem` },
    network: { available: snapshot.host.networkLatencyMs != null && snapshot.host.network !== 'unknown', icon: '$(radio-tower)', text: snapshot.host.network === 'offline' ? '$(radio-tower)     ×' : `$(radio-tower) ${formatLatency(snapshot.host.networkLatencyMs)}`, value: snapshot.host.networkLatencyMs, tooltip: `DNS reachability · ${snapshot.host.network || 'unknown'}\nStable DNS lookup · ${snapshot.host.networkLatencyMs ?? 'unavailable'}ms\nLatest raw lookup · ${snapshot.host.networkRawLatencyMs ?? 'unavailable'}ms\nThis is not full LLM request latency.\nRemote · ${snapshot.remoteName || 'local'}` }
  };
  for (const [kind, data] of Object.entries(resources)) {
    const observedColor = data.available && snapshot.freshness === 'fresh' ? metricStatus(kind, data.value, snapshot.host) : 'gray';
    displayColors[kind] = stabilizeColor(displayColors[kind], observedColor);
    const color = displayColors[kind].color;
    resourceItems[kind].text = data.available ? data.text : `${data.icon}$(circle-slash)`;
    resourceItems[kind].color = color === 'green' ? undefined : foregroundColors[color];
    resourceItems[kind].tooltip = `${data.available ? data.tooltip : `${kind[0].toUpperCase()}${kind.slice(1)} metric unavailable`}\n\nClick for Agent Runtime Lens dashboard.`;
    resourceItems[kind].accessibilityInformation = { label: `Agent Runtime Lens ${kind}: ${data.available ? data.tooltip.replace(/\n/g, ', ') : 'unavailable'}` };
    if (mode === 'minimal') resourceItems[kind].hide(); else resourceItems[kind].show();
  }
}

async function refreshOnce() {
  try {
    const config = vscode.workspace.getConfiguration('agentRuntimeLens');
    const slowMs = config.get('slowThresholdSeconds', 45) * 1000;
    const workspacePaths = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const [host, peerHost, observations] = await Promise.all([sampleHost(workspacePaths), sampleWindowsPeerFromWsl(), detectAgents(workspacePaths)]);
    host.networkRawLatencyMs = host.networkLatencyMs;
    if (Number.isFinite(host.networkLatencyMs)) {
      networkSamples.push(host.networkLatencyMs);
      if (networkSamples.length > 5) networkSamples.shift();
      host.networkLatencyMs = median(networkSamples);
    }
    await clineApiAdapter?.connect();
    const persistedCline = observations.find(item => item.id === 'cline');
    if (shouldUseLiveObservation(liveCline, persistedCline)) {
      const index = observations.findIndex(item => item.id === 'cline');
      if (index >= 0) observations[index] = liveCline;
      else observations.push(liveCline);
    }
    if (!observations.some(item => item.id === 'cline') && vscode.extensions.getExtension('saoudrizwan.claude-dev')) {
      observations.push({ id: 'cline', name: 'Cline', phase: 'idle', active: false, processAlive: true, lastActivityAt: Date.now(), evidence: `Cline is installed in the ${vscode.extensions.getExtension('saoudrizwan.claude-dev').extensionKind === vscode.ExtensionKind.UI ? 'local UI' : 'workspace'} extension host; no live task event is exposed`, evidenceSource: 'inferred', confidence: 'observed', visibilityLimited: true });
    }
    const copilotExtension = vscode.extensions.getExtension('github.copilot-chat') || vscode.extensions.getExtension('github.copilot');
    if (copilotExtension) {
      observations.push({ id: 'copilot', name: 'GitHub Copilot', phase: 'idle', active: false, processAlive: true, lastActivityAt: Date.now(), evidence: 'Copilot is installed; its session lifecycle uses private proposed APIs that are unavailable to Marketplace extensions', evidenceSource: 'inferred', confidence: 'observed', unsupportedTelemetry: true });
    }
    const inactiveCline = observations.find(item => item.id === 'cline' && !item.active);
    if (inactiveCline && inactiveCline.confidence !== 'verified' && vscode.extensions.getExtension('saoudrizwan.claude-dev')) {
      inactiveCline.visibilityLimited = true;
      inactiveCline.evidence = 'Cline is installed, but its persisted task evidence is not updating';
    }
    const agents = observations.map(item => classifyAgent(item, Date.now(), slowMs));
    const clineExtension = vscode.extensions.getExtension('saoudrizwan.claude-dev');
    const sampledAt = Date.now();
    const observedHealth = hostHealth(host);
    displayColors.host = stabilizeColor(displayColors.host, observedHealth.color);
    const health = { ...observedHealth, color: displayColors.host.color, reasons: displayColors.host.color !== observedHealth.color ? ['Resource readings are recovering; waiting for stability'] : observedHealth.reasons };
    snapshot = { agents, host, peerHost, health, peerHealth: peerHost && !peerHost.unavailable ? hostHealth(peerHost) : undefined, sampledAt, freshness: dataFreshness(host.sampledAt, sampledAt, Math.max(15000, config.get('refreshIntervalSeconds', 3) * 4000)), remoteName: vscode.env.remoteName || null, integrations: { clineVersion: clineExtension?.packageJSON?.version, clineApi: clineApiAdapter?.connected ? 'connected' : 'not exposed', clineApiShape: clineApiAdapter?.apiShape || [] } };
    const currentAgent = choosePrimary(snapshot.agents);
    const previous = timeline.at(-1);
    const previousAgent = previous && choosePrimary(previous.agents);
    const signature = `${currentAgent?.name}|${currentAgent?.label}|${currentAgent?.evidenceSource}|${currentAgent?.evidence}|${snapshot.health.color}`;
    const previousSignature = previous && `${previousAgent?.name}|${previousAgent?.label}|${previousAgent?.evidenceSource}|${previousAgent?.evidence}|${previous.health.color}`;
    if (!previous || signature !== previousSignature || snapshot.sampledAt - previous.sampledAt >= 30_000) timeline.push(snapshot);
    if (timeline.length > 300) timeline.shift();
    updateStatus();
    renderDashboard();
  } catch (error) {
    statusItem.text = '$(error) Agent Runtime Lens unavailable';
    statusItem.backgroundColor = colors.red;
    statusItem.tooltip = `Agent Runtime Lens sampling failed: ${error?.message || 'unknown error'}`;
    for (const [kind, item] of Object.entries(resourceItems)) {
      item.text = kind === 'environment' ? '$(remote) UNKNOWN$(circle-slash)' : '$(circle-slash)';
      item.color = foregroundColors.gray;
      item.tooltip = 'Metric unavailable because the latest sampling cycle failed.';
      item.show();
    }
    console.error('Agent Runtime Lens refresh failed', error);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { await refreshOnce(); } finally { refreshing = false; }
}

async function showStatus() {
  const primary = choosePrimary(snapshot.agents);
  const items = [{ label: `$(info) ${diagnosis(primary, snapshot.health)}`, description: 'Current diagnosis' }];
  for (const agent of snapshot.agents) {
    const icon = agent.color === 'red' ? 'error' : agent.color === 'yellow' ? 'warning' : agent.color === 'blue' ? 'person' : agent.color === 'gray' ? 'circle-slash' : 'circle-filled';
    items.push({ label: `$(${icon}) ${agent.name}: ${agent.label}`, description: `${evidenceLabel(agent)} · ${agent.evidence || 'No evidence description'}` });
  }
  const healthLabel = snapshot.health.color === 'red' ? 'Critical' : snapshot.health.color === 'yellow' ? 'Pressure' : 'Healthy';
  items.push({ label: `$(pulse) Environment: ${healthLabel}`, description: `CPU ${snapshot.host.cpuPercent ?? '?'}% · Memory ${snapshot.host.memoryPercent ?? '?'}% · Disk free ${snapshot.host.diskFreePercent ?? '?'}% · Network ${snapshot.host.network ?? 'unknown'} ${snapshot.host.networkLatencyMs ?? '?'}ms` });
  items.push({ label: `$(plug) Cline live API: ${snapshot.integrations?.clineApi || 'checking'}`, description: snapshot.integrations?.clineApiShape?.length ? `Exported keys: ${snapshot.integrations.clineApiShape.join(', ')}` : 'This Cline cohort has not exposed a subscribable event API' });
  items.push({ label: '$(graph) Open timeline dashboard', command: 'agentRuntimeLens.openDashboard' });
  items.push({ label: '$(export) Export redacted diagnostics', command: 'agentRuntimeLens.exportDiagnostics' });
  items.push({ label: '$(debug-restart) Reload VS Code Window', command: 'workbench.action.reloadWindow' });
  const selected = await vscode.window.showQuickPick(items, { title: 'Agent Runtime Lens — Current Status', placeHolder: 'Select an action or inspect the current evidence' });
  if (selected?.command) await vscode.commands.executeCommand(selected.command);
}

async function exportDiagnostics() {
  const target = await vscode.window.showSaveDialog({ title: 'Export Agent Runtime Lens diagnostics', defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), `agent-runtime-lens-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)), filters: { JSON: ['json'] } });
  if (!target) return;
  const payload = redact({ schemaVersion: 2, generatedAt: new Date().toISOString(), privacy: { includesPrompts: false, includesResponses: false, includesSourceCode: false, redacted: true }, capabilities: { cline: 'live-or-lifecycle', claudeCode: 'observed', githubCopilot: 'installed-only', localPeerFromWsl: true, localPeerFromSsh: false }, diagnosis: diagnosis(choosePrimary(snapshot.agents), snapshot.health), current: snapshot, timeline });
  await fs.promises.writeFile(target.fsPath, JSON.stringify(payload, null, 2), 'utf8');
  const action = await vscode.window.showInformationMessage('Agent Runtime Lens diagnostics exported without prompt or source-code content.', 'Open File');
  if (action === 'Open File') await vscode.window.showTextDocument(target);
}

async function enableClineIntegration() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return vscode.window.showErrorMessage('Open a workspace before enabling Cline deep visibility.');
  const destination = vscode.Uri.joinPath(folder.uri, '.cline', 'plugins', 'agent-runtime-lens.ts');
  const source = vscode.Uri.file(path.join(__dirname, '..', 'assets', 'agent-runtime-lens-cline-plugin.ts'));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.cline', 'plugins'));
  await vscode.workspace.fs.copy(source, destination, { overwrite: true });
  vscode.window.showInformationMessage('Cline deep visibility enabled for this workspace. Start a new Cline session so it loads the observer plugin.');
}

function activate(context) {
  clineApiAdapter = createClineApiAdapter(vscode, observation => { liveCline = observation; });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Agent Runtime Lens';
  statusItem.command = 'agentRuntimeLens.showStatus';
  rescueItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  rescueItem.name = 'Agent Runtime Lens Reload Window Rescue';
  rescueItem.text = '$(debug-restart)';
  rescueItem.tooltip = 'Reload VS Code Window · rescue a stuck Agent or remote development connection';
  rescueItem.command = 'workbench.action.reloadWindow';
  rescueItem.accessibilityInformation = { label: 'Reload VS Code Window. Rescue a stuck Agent or remote connection.' };
  for (const [index, kind] of ['environment', 'cpu', 'memory', 'disk', 'network'].entries()) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99 - index);
    item.name = `Agent Runtime Lens ${kind}`;
    item.command = 'agentRuntimeLens.openDashboard';
    resourceItems[kind] = item;
  }
  context.subscriptions.push(statusItem, rescueItem, ...Object.values(resourceItems), clineApiAdapter,
    vscode.commands.registerCommand('agentRuntimeLens.showStatus', showStatus),
    vscode.commands.registerCommand('agentRuntimeLens.runDiagnosis', showStatus),
    vscode.commands.registerCommand('agentRuntimeLens.openDashboard', openDashboard),
    vscode.commands.registerCommand('agentRuntimeLens.enableClineIntegration', enableClineIntegration),
    vscode.commands.registerCommand('agentRuntimeLens.exportDiagnostics', exportDiagnostics),
    vscode.commands.registerCommand('agentRuntimeLens.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('agentRuntimeLens')) schedule(); })
  );
  schedule();
}

function schedule() {
  if (timer) clearInterval(timer);
  refresh();
  const seconds = vscode.workspace.getConfiguration('agentRuntimeLens').get('refreshIntervalSeconds', 3);
  if (vscode.workspace.getConfiguration('agentRuntimeLens').get('showReloadButton', true)) rescueItem?.show(); else rescueItem?.hide();
  timer = setInterval(refresh, seconds * 1000);
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
