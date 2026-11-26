import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = "ui://agy-flow-monitor/app.html";
const HTML_PATH = process.env.AGY_MONITOR_HTML || path.join(__dirname, "app.html");
const DEFAULT_BRAIN_DIR =
  process.env.AGY_BRAIN_DIR ||
  path.join(os.homedir(), ".gemini", "antigravity", "brain");
const DISABLE_LOCAL_PROBE = process.env.AGY_MONITOR_NO_LOCAL_PROBE === "1";

const MAX_INITIAL_READ_BYTES = 4 * 1024 * 1024; // 4 MiB cap on cold load
const SUBAGENT_TAIL_BYTES = 64 * 1024; // 64 KiB tail cap for subagents
const MAX_CACHED_STEPS = 500; // Rolling window cap for bounded RAM & CPU
const MAX_CACHE_ENTRIES = 16;

const transcriptCache = new Map();
const subagentCache = new Map();

let localLlmCache = {
  checkedAt: 0,
  state: { status: "standby", model: "unloaded", endpoint: "127.0.0.1" },
};

export function clearTelemetryCaches() {
  transcriptCache.clear();
  subagentCache.clear();
}

async function probeLocalLlm() {
  if (DISABLE_LOCAL_PROBE) {
    return { status: "disabled", model: "probe off", endpoint: "local" };
  }
  const now = Date.now();
  if (now - localLlmCache.checkedAt < 2500) {
    return localLlmCache.state;
  }
  let state = { status: "standby", model: "unloaded", endpoint: "127.0.0.1" };
  try {
    const res = await fetch("http://127.0.0.1:11434/api/ps", {
      signal: AbortSignal.timeout(150),
    });
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      if (models.length > 0) {
        state = {
          status: "active",
          model: models[0].name || "ollama-model",
          endpoint: "127.0.0.1:11434",
        };
      } else {
        state = {
          status: "ready",
          model: "ollama idle",
          endpoint: "127.0.0.1:11434",
        };
      }
      localLlmCache = { checkedAt: now, state };
      return state;
    }
  } catch {
    // Ollama not running
  }
  try {
    const res = await fetch("http://127.0.0.1:8080/health", {
      signal: AbortSignal.timeout(150),
    });
    if (res.ok) {
      state = {
        status: "active",
        model: "llama.cpp",
        endpoint: "127.0.0.1:8080",
      };
    }
  } catch {
    // llama.cpp not running
  }
  localLlmCache = { checkedAt: now, state };
  return state;
}

function formatTime(isoStr) {
  if (!isoStr) return "--:--:--";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

function humanizeModel(raw) {
  if (!raw) return "Agent Model";
  return raw
    .replace(/^gemini-/i, "Gemini ")
    .replace(/^claude-/i, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getContextLimit(rawModel) {
  const m = String(rawModel || "").toLowerCase();
  if (!m) return 1_000_000;
  if (m.includes("claude") && !m.includes("1m")) return 200_000;
  if (m.includes("gpt-4o") || m.includes("gpt-4-")) return 128_000;
  if (m.includes("o1") || m.includes("o3")) return 200_000;
  return 1_000_000;
}

function unquoteArg(val) {
  if (typeof val !== "string") return val;
  if (val.startsWith('"') && val.endsWith('"')) {
    try {
      return JSON.parse(val);
    } catch {
      return val.slice(1, -1);
    }
  }
  return val;
}

function readRangeSync(filePath, startOffset, byteLength) {
  if (byteLength <= 0) return "";
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(byteLength);
    const bytes = fs.readSync(fd, buf, 0, byteLength, startOffset);
    return buf.subarray(0, bytes).toString("utf8");
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

export function readFirstLine(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    const text = buf.subarray(0, bytes).toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

export function readTranscriptIncremental(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { steps: [], cacheHit: false };
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { steps: cached.steps, cacheHit: true };
  }

  // Incremental append path: always read from cached.offset (start of any incomplete trailing line)
  if (cached && stat.size > cached.size && cached.offset <= stat.size) {
    const deltaBytes = stat.size - cached.offset;
    if (deltaBytes <= MAX_INITIAL_READ_BYTES) {
      try {
        const chunk = readRangeSync(filePath, cached.offset, deltaBytes);
        const parts = chunk.split("\n");
        const trailing = parts.pop() || "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            cached.steps.push(JSON.parse(trimmed));
          } catch {
            // skip malformed line
          }
        }
        let trailingBytes = Buffer.byteLength(trailing, "utf8");
        if (trailing.trim()) {
          try {
            cached.steps.push(JSON.parse(trailing.trim()));
            trailingBytes = 0;
          } catch {
            // incomplete trailing line: keep cached.offset at start of trailing
          }
        } else {
          trailingBytes = 0;
        }
        if (cached.steps.length > MAX_CACHED_STEPS) {
          cached.steps = cached.steps.slice(-MAX_CACHED_STEPS);
        }
        cached.mtimeMs = stat.mtimeMs;
        cached.size = stat.size;
        cached.offset = stat.size - trailingBytes;
        return { steps: cached.steps, cacheHit: false };
      } catch {
        // fall through to cold read
      }
    }
  }

  // Cold read (bounded to last MAX_INITIAL_READ_BYTES and MAX_CACHED_STEPS)
  try {
    const startOffset = Math.max(0, stat.size - MAX_INITIAL_READ_BYTES);
    const toRead = stat.size - startOffset;
    const raw = readRangeSync(filePath, startOffset, toRead);
    const parts = raw.split("\n");
    if (startOffset > 0) {
      parts.shift();
    }
    const trailing = parts.pop() || "";
    const steps = [];
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        steps.push(JSON.parse(trimmed));
      } catch {
        // skip malformed line
      }
    }
    let trailingBytes = Buffer.byteLength(trailing, "utf8");
    if (trailing.trim()) {
      try {
        steps.push(JSON.parse(trailing.trim()));
        trailingBytes = 0;
      } catch {
        // incomplete trailing line
      }
    } else {
      trailingBytes = 0;
    }

    const boundedSteps =
      steps.length > MAX_CACHED_STEPS ? steps.slice(-MAX_CACHED_STEPS) : steps;

    if (transcriptCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = transcriptCache.keys().next().value;
      if (oldestKey) transcriptCache.delete(oldestKey);
    }
    transcriptCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      offset: stat.size - trailingBytes,
      steps: boundedSteps,
    });
    return { steps: boundedSteps, cacheHit: false };
  } catch {
    return { steps: [], cacheHit: false };
  }
}

export function listConversations(brainDir = DEFAULT_BRAIN_DIR) {
  let entries;
  try {
    if (!fs.existsSync(brainDir)) return [];
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tPath = path.join(
      brainDir,
      entry.name,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (!fs.existsSync(tPath)) continue;
    try {
      const stat = fs.statSync(tPath);
      const firstLine = readFirstLine(tPath);
      let isMain = false;
      let title = entry.name.slice(0, 8);
      if (firstLine) {
        try {
          const obj = JSON.parse(firstLine);
          isMain =
            obj.source === "USER_EXPLICIT" &&
            typeof obj.content === "string" &&
            obj.content.includes("<USER_REQUEST>");
          if (typeof obj.content === "string") {
            const m = obj.content.match(
              /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
            );
            const rawTitle = (m ? m[1] : obj.content)
              .replace(/\s+/g, " ")
              .trim();
            if (rawTitle) title = rawTitle.slice(0, 36);
          }
        } catch {
          // ignore parse error
        }
      }
      list.push({
        id: entry.name,
        path: tPath,
        mtimeMs: stat.mtimeMs,
        isMain,
        title,
      });
    } catch {
      // ignore stat error
    }
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list;
}

export function inspectSubagentTranscript(convId, brainDir = DEFAULT_BRAIN_DIR) {
  const tPath = path.join(
    brainDir,
    convId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
  let stat;
  try {
    stat = fs.statSync(tPath);
  } catch {
    return { status: "done", progress: 100, steps: 0, lastTool: "" };
  }

  const cached = subagentCache.get(tPath);
  let meta;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    meta = cached;
  } else {
    try {
      const startOffset = Math.max(0, stat.size - SUBAGENT_TAIL_BYTES);
      const raw = readRangeSync(tPath, startOffset, stat.size - startOffset);
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (startOffset > 0 && lines.length > 0) lines.shift();

      let lastTool = "";
      let lastType = "";
      let lastHasTools = false;
      let stepCount = lines.length;
      for (const line of lines.slice(-15)) {
        try {
          const obj = JSON.parse(line);
          lastType = obj.type || "";
          if (typeof obj.step_index === "number") {
            stepCount = Math.max(stepCount, obj.step_index + 1);
          }
          if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
            lastTool =
              obj.tool_calls[obj.tool_calls.length - 1].name || lastTool;
            lastHasTools = true;
          } else if (obj.type === "PLANNER_RESPONSE") {
            lastHasTools = false;
          }
        } catch {
          // ignore
        }
      }
      meta = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        lastTool,
        lastType,
        lastHasTools,
        stepCount,
      };
      if (subagentCache.size >= MAX_CACHE_ENTRIES * 2) {
        const oldestKey = subagentCache.keys().next().value;
        if (oldestKey) subagentCache.delete(oldestKey);
      }
      subagentCache.set(tPath, meta);
    } catch {
      return { status: "done", progress: 100, steps: 0, lastTool: "" };
    }
  }

  const ageMs = Date.now() - meta.mtimeMs;
  const isRunning =
    ageMs < 15000 &&
    (meta.lastHasTools || meta.lastType !== "PLANNER_RESPONSE");
  return {
    status: isRunning ? "running" : "done",
    progress: isRunning ? Math.min(92, 18 + meta.stepCount * 7) : 100,
    steps: meta.stepCount,
    lastTool: meta.lastTool,
    mtimeMs: meta.mtimeMs,
  };
}

export async function collectTelemetry(
  requestedConvId,
  options = {}
) {
  const brainDir = options.brainDir || DEFAULT_BRAIN_DIR;
  const skipLocalProbe = options.skipLocalProbe ?? DISABLE_LOCAL_PROBE;
  const now = Date.now();
  const [localLlm, allConvs] = await Promise.all([
    skipLocalProbe
      ? Promise.resolve({ status: "disabled", model: "probe off", endpoint: "local" })
      : probeLocalLlm(),
    Promise.resolve(listConversations(brainDir)),
  ]);
  const mainConvs = allConvs.filter((c) => c.isMain);
  const candidates = mainConvs.length > 0 ? mainConvs : allConvs;

  let target = null;
  if (requestedConvId && requestedConvId !== "auto") {
    target =
      allConvs.find((c) => c.id === requestedConvId) || candidates[0] || null;
  } else {
    target = candidates[0] || null;
  }

  const telemetry = {
    timestamp: new Date().toISOString(),
    stepSeq: 0,
    conversationId: target ? target.id : null,
    conversationTitle: target ? target.title : "No active session",
    conversations: candidates.slice(0, 8).map((c) => ({
      id: c.id,
      shortId: c.id.slice(0, 8),
      title: c.title,
      updatedAgoSec: Math.max(0, Math.round((now - c.mtimeMs) / 1000)),
    })),
    metrics: {
      contextTokens: 0,
      contextLimit: 1_000_000,
      contextPct: 0,
      cacheHitPct: 0,
      tps: 0,
      lastLatencyMs: 0,
      inFlightTools: 0,
    },
    layer0: localLlm,
    mcpLayer: {
      mode: "generic",
      totalCalls: 0,
      status: "standby",
      meters: [
        { key: "slot0", label: "mcp-1", score: null, mode: "idle", count: 0 },
        { key: "slot1", label: "mcp-2", score: null, mode: "idle", count: 0 },
        { key: "slot2", label: "mcp-3", score: null, mode: "idle", count: 0 },
      ],
    },
    mainLayer: {
      model: "Agent Model",
      rawModel: "",
      status: "idle",
      steps: 0,
      toolCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastTool: "",
      parallelMode: "tools",
      subagents: [],
      recentTools: [],
    },
    advisorLayer: {
      calls: 0,
      status: "on call",
      activeTrigger: -1,
      lastAdvice: [],
      tokensRead: 0,
    },
    pulses: {
      local_active: localLlm.status === "active",
      mcp_active: false,
      main_active: false,
      fanout_active: false,
      return_active: false,
      advisor_active: false,
    },
    timeline: [],
    logs: [],
  };

  if (!target) return telemetry;

  const { steps: parsedSteps } = readTranscriptIncremental(target.path);
  telemetry.mainLayer.steps = parsedSteps.length;
  const subagentMap = new Map();
  const genericMcpCounts = new Map();
  const jevMeters = [
    { key: "choice", label: "choice", score: null, mode: "idle", count: 0 },
    { key: "noul", label: "noul", score: null, mode: "idle", count: 0 },
    { key: "score", label: "score", score: null, mode: "idle", count: 0 },
  ];
  let jevCount = 0;

  let lastStepTimeMs = 0;
  let lastPlannerTimeMs = 0;
  let lastPlannerOutputTokens = 0;
  let lastPlannerCalls = [];
  let genericResultsAfterLastPlanner = 0;
  const recentLogs = [];
  const timeline = [];

  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i];
    const stepTimeMs = step.created_at ? new Date(step.created_at).getTime() : 0;
    if (stepTimeMs > lastStepTimeMs) lastStepTimeMs = stepTimeMs;
    const isRecent = now - stepTimeMs < 30000;

    if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT") {
      const m = (step.content || "").match(
        /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
      );
      const text = (m ? m[1] : step.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 48);
      timeline.push({ layer: "user", height: 42, label: "user prompt" });
      recentLogs.push({
        time: formatTime(step.created_at),
        actor: "user",
        label: "prompt",
        detail: text || "user request",
        meta: "",
        tone: "info",
      });
    }

    if (step.type === "GENERIC") {
      genericResultsAfterLastPlanner += 1;
      if (lastPlannerTimeMs > 0 && stepTimeMs >= lastPlannerTimeMs) {
        telemetry.metrics.lastLatencyMs = Math.max(
          100,
          stepTimeMs - lastPlannerTimeMs
        );
      }
      if (isRecent) {
        telemetry.pulses.return_active = true;
      }
    }

    if (step.type === "PLANNER_RESPONSE") {
      const inTok = Number(step.input_tokens || 0);
      const cacheTok = Number(step.cache_read_tokens || 0);
      const outTok = Number(step.output_tokens || 0);

      if (step.model) {
        telemetry.mainLayer.rawModel = step.model;
        telemetry.mainLayer.model = humanizeModel(step.model);
        telemetry.metrics.contextLimit = getContextLimit(step.model);
      }
      telemetry.mainLayer.inputTokens += inTok;
      telemetry.mainLayer.cacheReadTokens += cacheTok;
      telemetry.mainLayer.outputTokens += outTok;

      const activeCtx = inTok + cacheTok;
      if (activeCtx > 0) {
        telemetry.metrics.contextTokens = activeCtx;
        telemetry.metrics.contextPct = Math.min(
          100,
          Number(
            ((activeCtx / telemetry.metrics.contextLimit) * 100).toFixed(1)
          )
        );
        telemetry.metrics.cacheHitPct = Math.round(
          (cacheTok / activeCtx) * 100
        );
      }

      if (
        lastPlannerTimeMs > 0 &&
        stepTimeMs > lastPlannerTimeMs &&
        lastPlannerOutputTokens > 0
      ) {
        const dtSec = Math.max(0.5, (stepTimeMs - lastPlannerTimeMs) / 1000);
        telemetry.metrics.tps = Math.min(
          250,
          Math.round(lastPlannerOutputTokens / dtSec)
        );
      }
      lastPlannerTimeMs = stepTimeMs;
      lastPlannerOutputTokens = outTok;

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        lastPlannerCalls = calls;
        genericResultsAfterLastPlanner = 0;
      }
      telemetry.mainLayer.toolCalls += calls.length;

      let stepLayer = "main";
      for (const tc of calls) {
        const name = tc.name || "tool";
        const args = tc.args || {};
        telemetry.mainLayer.lastTool = name;

        const serverName = unquoteArg(args.ServerName || "");
        const toolName = unquoteArg(args.ToolName || name);
        const isMcpDirect = name.startsWith("mcp_");
        const resolvedServer =
          serverName || (isMcpDirect ? name.split("_")[1] || "mcp" : "");

        if (
          resolvedServer === "typesafe-ai" ||
          String(toolName).startsWith("typesafe_")
        ) {
          stepLayer = "mcp";
          jevCount += 1;
          telemetry.mcpLayer.totalCalls += 1;
          if (isRecent) {
            telemetry.mcpLayer.status = "routing";
            telemetry.pulses.mcp_active = true;
          }
          const nextStep = parsedSteps[i + 1];
          const nextText =
            typeof nextStep?.content === "string" ? nextStep.content : "";
          const probMatch =
            nextText.match(
              /(?:probability|confidence|score)["']?\s*[:=]\s*(0?\.\d+|1\.0)/i
            ) || nextText.match(/\b(0\.\d{2})\b/);
          const score = probMatch
            ? Math.min(0.99, Math.max(0.01, parseFloat(probMatch[1])))
            : 0.91;
          const mode = score >= 0.75 ? "sharp" : "split";

          const meterKey = String(toolName).includes("noul")
            ? "noul"
            : String(toolName).includes("score") ||
                String(toolName).includes("batch")
              ? "score"
              : "choice";
          const meter = jevMeters.find((m) => m.key === meterKey);
          if (meter) {
            meter.score = score;
            meter.mode = mode;
            meter.count += 1;
          }

          recentLogs.push({
            time: formatTime(step.created_at),
            actor: "mcp",
            label: String(toolName).replace("typesafe_", "jev:"),
            detail: mode === "sharp" ? "routed fast" : "escalated",
            meta: `p=${score.toFixed(2)} ${mode}`,
            tone: mode,
          });
        } else if (
          resolvedServer.includes("audit") ||
          String(toolName).includes("audit")
        ) {
          stepLayer = "advisor";
          telemetry.advisorLayer.calls += 1;
          telemetry.advisorLayer.tokensRead =
            telemetry.metrics.contextTokens || telemetry.mainLayer.totalTokens;
          if (isRecent) {
            telemetry.advisorLayer.status = "advising";
            telemetry.advisorLayer.activeTrigger =
              telemetry.advisorLayer.calls % 3;
            telemetry.pulses.advisor_active = true;
          }
          const nextStep = parsedSteps[i + 1];
          if (typeof nextStep?.content === "string" && nextStep.content.trim()) {
            const clean = nextStep.content.replace(/\s+/g, " ").trim();
            telemetry.advisorLayer.lastAdvice = [
              clean.slice(0, 34),
              clean.slice(34, 68),
            ].filter(Boolean);
          }
          recentLogs.push({
            time: formatTime(step.created_at),
            actor: "advisor",
            label: String(toolName),
            detail: "deep audit review",
            meta: `call #${telemetry.advisorLayer.calls}`,
            tone: "info",
          });
        } else if (name === "call_mcp_tool" || isMcpDirect) {
          stepLayer = "mcp";
          const srvKey = (resolvedServer || "mcp").slice(0, 14);
          genericMcpCounts.set(srvKey, (genericMcpCounts.get(srvKey) || 0) + 1);
          telemetry.mcpLayer.totalCalls += 1;
          if (isRecent) {
            telemetry.mcpLayer.status = "active";
            telemetry.pulses.mcp_active = true;
          }
          recentLogs.push({
            time: formatTime(step.created_at),
            actor: "mcp",
            label: srvKey,
            detail: String(toolName).slice(0, 34),
            meta: "mcp",
            tone: "sharp",
          });
        } else if (name === "invoke_subagent") {
          stepLayer = "swarm";
          const role = unquoteArg(args.Role || "Subagent");
          const typeName = unquoteArg(args.TypeName || "agent");
          const model = unquoteArg(args.Model || "inherit");
          const nextStep = parsedSteps[i + 1];
          let subConvId = `__fallback_sub__-${i}`;
          if (typeof nextStep?.content === "string") {
            const idMatch = nextStep.content.match(
              /"conversationId"\s*:\s*"([^"]+)"/
            );
            if (idMatch) subConvId = idMatch[1];
          }
          const subInfo = subConvId.startsWith("__fallback_sub__-")
            ? { status: "done", progress: 100, steps: 1, lastTool: "" }
            : inspectSubagentTranscript(subConvId, brainDir);

          subagentMap.set(subConvId, {
            id: subConvId,
            role: String(role).slice(0, 22),
            type: String(typeName),
            model: String(model),
            status: subInfo.status,
            progress: subInfo.progress,
            steps: subInfo.steps,
            lastTool: subInfo.lastTool,
          });

          if (isRecent || subInfo.status === "running") {
            telemetry.pulses.fanout_active = true;
          }

          recentLogs.push({
            time: formatTime(step.created_at),
            actor: "subagent",
            label: String(typeName),
            detail: String(role).slice(0, 36),
            meta: subInfo.status === "running" ? `${subInfo.progress}%` : "done",
            tone: "info",
          });
        } else if (name !== "update_steps" && name !== "update_focus") {
          const summary = unquoteArg(
            args.toolSummary || args.Path || args.query || args.domain || ""
          ).toString();
          const shortDetail = summary
            ? path.basename(summary).slice(0, 32)
            : name;
          recentLogs.push({
            time: formatTime(step.created_at),
            actor: "main",
            label: name,
            detail: shortDetail,
            meta: outTok ? `${outTok} tok` : "",
            tone: "info",
          });
        }
      }

      const barHeight = Math.min(
        100,
        Math.max(22, Math.round(25 + Math.log10(Math.max(10, outTok)) * 22))
      );
      timeline.push({
        layer: stepLayer,
        height: barHeight,
        label:
          calls.length > 0
            ? calls.map((c) => c.name).join(",")
            : `reply (${outTok}t)`,
      });
    }

    if (
      step.type === "SYSTEM_MESSAGE" &&
      typeof step.content === "string" &&
      step.content.includes("COMPLETED")
    ) {
      if (isRecent) telemetry.pulses.return_active = true;
      timeline.push({ layer: "swarm", height: 55, label: "subagent done" });
      recentLogs.push({
        time: formatTime(step.created_at),
        actor: "subagent",
        label: "return",
        detail: "subagent result merged",
        meta: "-> main",
        tone: "sharp",
      });
    }
  }

  if (jevCount > 0) {
    telemetry.mcpLayer.mode = "jev";
    telemetry.mcpLayer.meters = jevMeters;
  } else if (genericMcpCounts.size > 0) {
    telemetry.mcpLayer.mode = "generic";
    const sorted = Array.from(genericMcpCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const maxCnt = Math.max(1, sorted[0][1]);
    telemetry.mcpLayer.meters = [0, 1, 2].map((idx) => {
      const entry = sorted[idx];
      if (!entry) {
        return {
          key: `slot${idx}`,
          label: `mcp-${idx + 1}`,
          score: null,
          mode: "idle",
          count: 0,
        };
      }
      return {
        key: `slot${idx}`,
        label: entry[0],
        score: Math.min(1, entry[1] / maxCnt),
        mode: "sharp",
        count: entry[1],
      };
    });
  }

  telemetry.mainLayer.totalTokens =
    telemetry.mainLayer.inputTokens +
    telemetry.mainLayer.cacheReadTokens +
    telemetry.mainLayer.outputTokens;
  telemetry.mainLayer.subagents = Array.from(subagentMap.values()).slice(-3);

  const visibleCalls = lastPlannerCalls.filter(
    (c) => c.name !== "update_steps" && c.name !== "update_focus"
  );
  const inFlight = Math.max(
    0,
    lastPlannerCalls.length - genericResultsAfterLastPlanner
  );
  telemetry.metrics.inFlightTools = inFlight;

  telemetry.mainLayer.recentTools = visibleCalls.slice(0, 3).map((tc, idx) => {
    const isDone =
      idx < genericResultsAfterLastPlanner || now - lastStepTimeMs > 25000;
    const args = tc.args || {};
    const hint = unquoteArg(
      args.toolSummary || args.query || args.Path || args.domain || tc.name || ""
    ).toString();
    const shortHint = hint ? path.basename(hint).slice(0, 18) : tc.name;
    return {
      id: `tool-${idx}`,
      role: tc.name || "tool",
      type: shortHint,
      model: "main",
      status: isDone ? "done" : "running",
      progress: isDone
        ? 100
        : Math.min(
            88,
            30 + Math.round(((now - lastPlannerTimeMs) / 1000) * 14)
          ),
      steps: 1,
      lastTool: tc.name || "",
    };
  });

  const anySubRunning = telemetry.mainLayer.subagents.some(
    (s) => s.status === "running"
  );
  const lastStepAgeMs = now - lastStepTimeMs;

  telemetry.mainLayer.parallelMode =
    anySubRunning ||
    (telemetry.mainLayer.recentTools.length === 0 &&
      telemetry.mainLayer.subagents.length > 0)
      ? "subagents"
      : "tools";

  if (anySubRunning) {
    telemetry.mainLayer.status = "swarming";
  } else if (inFlight > 0 && lastStepAgeMs < 35000) {
    telemetry.mainLayer.status = "executing";
  } else if (lastStepAgeMs < 25000) {
    telemetry.mainLayer.status = "active";
  } else {
    telemetry.mainLayer.status = "ready";
  }

  if (lastStepAgeMs < 25000 || inFlight > 0) {
    telemetry.pulses.main_active = true;
    if (visibleCalls.length > 0 || anySubRunning) {
      telemetry.pulses.fanout_active = true;
    }
  }

  if (
    telemetry.mcpLayer.totalCalls > 0 &&
    telemetry.mcpLayer.status === "standby"
  ) {
    telemetry.mcpLayer.status = "ready";
  }
  if (telemetry.advisorLayer.tokensRead === 0) {
    telemetry.advisorLayer.tokensRead =
      telemetry.metrics.contextTokens || telemetry.mainLayer.totalTokens;
  }

  telemetry.stepSeq =
    telemetry.mainLayer.steps * 100 +
    telemetry.mainLayer.toolCalls +
    telemetry.mcpLayer.totalCalls;
  telemetry.timeline = timeline.slice(-28);
  telemetry.logs = recentLogs.slice(-10);
  return telemetry;
}

export function createMonitorServer() {
  const server = new Server(
    {
      name: "agy-flow-monitor",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: APP_URI,
        name: "AGY Flow Monitor UI",
        description:
          "Real-time terminal-style telemetry and execution flow dashboard for Google Antigravity",
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== APP_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    const html = fs.existsSync(HTML_PATH)
      ? fs.readFileSync(HTML_PATH, "utf8")
      : "<html><body><pre>App not built yet. Run npm run build.</pre></body></html>";
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "open_monitor",
        title: "AGY Flow Monitor",
        description:
          "Open the real-time execution flow and telemetry dashboard in the Antigravity side pane.",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: {
              type: "string",
              description:
                "Optional conversation ID to inspect. Defaults to the latest active conversation.",
            },
          },
        },
        _meta: {
          ui: {
            resourceUri: APP_URI,
          },
          "com.google.antigravity/ui": {
            entrypoints: [
              { type: "aux_pane", title: "AGY Flow Monitor" },
              { type: "global", title: "AGY Flow Monitor" },
            ],
          },
        },
      },
      {
        name: "poll_telemetry",
        title: "Poll Telemetry",
        description:
          "App-only tool returning the latest real-time telemetry snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: {
              type: "string",
              description: "Conversation ID or 'auto'",
            },
          },
        },
        _meta: {
          ui: {
            visibility: ["app"],
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "open_monitor" || name === "poll_telemetry") {
      const convId =
        typeof args?.conversationId === "string" ? args.conversationId : "auto";
      const data = await collectTelemetry(convId);
      const summaryText = `AGY Flow Monitor | Session: ${data.conversationId ? data.conversationId.slice(0, 8) : "none"} | CTX: ${data.metrics.contextPct}% | Cache: ${data.metrics.cacheHitPct}% | TPS: ${data.metrics.tps} | Model: ${data.mainLayer.model} (${data.mainLayer.status})`;
      return {
        content: [{ type: "text", text: summaryText }],
        structuredContent: data,
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

const isMainEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainEntry) {
  const server = createMonitorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
