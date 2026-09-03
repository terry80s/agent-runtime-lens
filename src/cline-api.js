'use strict';

function eventDescriptor(event) {
  if (!event || typeof event !== 'object') return '';
  return [event.type, event.kind, event.status, event.phase, event.name, event.event, event.payload?.type, event.payload?.status, event.payload?.phase, event.payload?.name]
    .filter(value => typeof value === 'string').join(' ').toLowerCase();
}

function phaseFromClineEvent(event, now = Date.now()) {
  const descriptor = eventDescriptor(event);
  const base = { id: 'cline', name: 'Cline', active: true, processAlive: true, lastActivityAt: now, confidence: 'verified', liveEvidence: true, evidenceSource: 'live' };
  if (/error|failed|fatal/.test(descriptor)) return { ...base, phase: 'failed', failed: true, evidence: `Cline API event:${descriptor || 'failure'}` };
  if (/approval|permission|confirm/.test(descriptor)) return { ...base, phase: 'approval', needsApproval: true, evidence: `Cline API event:${descriptor}` };
  if (/input[-_ ]required|waiting[-_ ]user|user[-_ ]input|ask|question|resumable/.test(descriptor)) return { ...base, phase: 'waiting_input', needsApproval: true, evidence: `Cline API event:${descriptor}` };
  if (/completed|complete|ended|done|finished/.test(descriptor)) return { ...base, phase: 'completed', active: false, evidence: `Cline API event:${descriptor}` };
  if (/read_file|read files|list_files/.test(descriptor)) return { ...base, phase: 'reading', evidence: `Cline API event:${descriptor}` };
  if (/search|grep|find/.test(descriptor)) return { ...base, phase: 'searching', evidence: `Cline API event:${descriptor}` };
  if (/edit|write|patch|replace/.test(descriptor)) return { ...base, phase: 'editing', evidence: `Cline API event:${descriptor}` };
  if (/mcp/.test(descriptor)) return { ...base, phase: 'mcp', evidence: `Cline API event:${descriptor}` };
  if (/browser/.test(descriptor)) return { ...base, phase: 'browser', evidence: `Cline API event:${descriptor}` };
  if (/command|shell|terminal/.test(descriptor)) return { ...base, phase: 'command', evidence: `Cline API event:${descriptor}` };
  if (/tool.*(?:start|update|call)|(?:start|update).*tool/.test(descriptor)) return { ...base, phase: 'tool', evidence: `Cline API event:${descriptor}` };
  if (/assistant[-_ ]text[-_ ]delta|reasoning[-_ ]delta|chunk|delta|stream/.test(descriptor)) return { ...base, phase: 'receiving_model', evidence: `Cline API event:${descriptor}` };
  if (/before[-_ ]model|model[-_ ]start|llm|api[-_ ]request|request[-_ ]started|send[-_ ]start/.test(descriptor)) return { ...base, phase: 'sending_model', evidence: `Cline API event:${descriptor}` };
  if (/parse|response_complete|send_complete|tool.*finish/.test(descriptor)) return { ...base, phase: 'parsing', evidence: `Cline API event:${descriptor}` };
  return { ...base, phase: 'undisclosed', evidence: `Cline API event:${descriptor || 'unclassified'}` };
}

function createClineApiAdapter(vscode, onObservation) {
  let connected = false;
  let disposable;
  let apiShape = [];

  function rememberDisposable(value) {
    if (typeof value === 'function') disposable = { dispose: value };
    else if (value && typeof value.dispose === 'function') disposable = value;
  }

  async function connect() {
    if (connected) return true;
    const extension = vscode.extensions.getExtension('saoudrizwan.claude-dev');
    if (!extension?.isActive) return false;
    const api = extension.exports;
    if (!api || (typeof api !== 'object' && typeof api !== 'function')) return false;
    apiShape = Object.keys(api).sort();
    const candidates = [api, api.cline, api.core, api.hub, api.runtime, api.client, api.events, api.session].filter(Boolean);
    for (const candidate of candidates) {
      for (const method of ['subscribe', 'onSessionEvent', 'onDidChangeState', 'onDidChangeTask']) {
        if (typeof candidate[method] !== 'function') continue;
        try {
          const result = candidate[method](event => onObservation(phaseFromClineEvent(event)));
          rememberDisposable(result);
          connected = true;
          return true;
        } catch { /* try the next documented event shape */ }
      }
    }
    return false;
  }

  return { connect, get connected() { return connected; }, get apiShape() { return apiShape; }, dispose() { disposable?.dispose(); } };
}

module.exports = { eventDescriptor, phaseFromClineEvent, createClineApiAdapter };
