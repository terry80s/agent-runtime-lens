import fs from "node:fs";
import path from "node:path";
import type { AgentPlugin } from "@cline/core";

let eventFile: string | undefined;
let lastPhase = "";
let lastEventAt = 0;

function emit(phase: string, detail?: string) {
  if (!eventFile) return;
  const now = Date.now();
  if (phase === lastPhase && now - lastEventAt < 2000) return;
  lastPhase = phase;
  lastEventAt = now;
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  fs.appendFileSync(eventFile, JSON.stringify({ timestamp: now, type: "agent_runtime_lens", phase, detail }) + "\n");
}

function toolPhase(name: string) {
  const value = name.toLowerCase();
  if (/read|list_files/.test(value)) return "reading";
  if (/search|grep|find/.test(value)) return "searching";
  if (/edit|write|patch|replace/.test(value)) return "editing";
  if (/mcp/.test(value)) return "mcp";
  if (/browser/.test(value)) return "browser";
  if (/command|shell|terminal/.test(value)) return "command";
  return "tool";
}

const plugin: AgentPlugin = {
  name: "agent-runtime-lens-observer",
  manifest: { capabilities: ["hooks"] },
  setup(_api, ctx) {
    const root = ctx.workspaceInfo?.rootPath;
    if (root) eventFile = path.join(root, ".cline", "agent-runtime-lens-events.jsonl");
  },
  hooks: {
    beforeRun() { emit("preparing_context"); },
    beforeModel() { emit("sending_model"); },
    afterModel() { emit("parsing"); },
    beforeTool({ toolCall }) { emit(toolPhase(toolCall.toolName), toolCall.toolName); },
    afterTool({ toolCall }) { emit("parsing", toolCall.toolName); },
    afterRun({ result }) { emit(result.status === "completed" ? "completed" : result.status === "failed" ? "failed" : "idle", result.status); },
    onEvent(event) {
      const type = typeof event?.type === "string" ? event.type : "event";
      if (/approval|permission/i.test(type)) emit("approval", type);
      else if (/input|required|question/i.test(type)) emit("waiting_input", type);
      else if (/delta|chunk|stream/i.test(type)) emit("receiving_model", type);
    },
  },
};

export default plugin;
