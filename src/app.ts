import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

interface WorkerCard {
  id: string;
  role: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  steps: number;
  lastTool: string;
}

interface TelemetryData {
  timestamp: string;
  stepSeq: number;
  conversationId: string | null;
  conversationTitle: string;
  conversations: Array<{
    id: string;
    shortId: string;
    title: string;
    updatedAgoSec: number;
  }>;
  metrics: {
    contextTokens: number;
    contextLimit: number;
    contextPct: number;
    cacheHitPct: number;
    tps: number;
    lastLatencyMs: number;
    inFlightTools: number;
  };
  layer0: { status: string; model: string; endpoint: string };
  mcpLayer: {
    mode: "generic" | "jev";
    totalCalls: number;
    status: string;
    meters: Array<{
      key: string;
      label: string;
      score: number | null;
      mode: string;
      count: number;
    }>;
  };
  mainLayer: {
    model: string;
    rawModel: string;
    status: string;
    steps: number;
    toolCalls: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    lastTool: string;
    parallelMode: "subagents" | "tools";
    subagents: WorkerCard[];
    recentTools: WorkerCard[];
  };
  advisorLayer: {
    calls: number;
    status: string;
    activeTrigger: number;
    lastAdvice: string[];
    tokensRead: number;
  };
  pulses: {
    local_active: boolean;
    mcp_active: boolean;
    main_active: boolean;
    fanout_active: boolean;
    return_active: boolean;
    advisor_active: boolean;
  };
  timeline: Array<{ layer: string; height: number; label: string }>;
  logs: Array<{
    time: string;
    actor: string;
    label: string;
    detail: string;
    meta?: string;
    tone?: string;
  }>;
}

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let mode: "live" | "demo" = "live";
let railVisible = true;
let selectedConvId = "auto";
let latestLiveData: TelemetryData | null = null;
let pollInFlight = false;
let pollCount = 0;
let lastStepSeq = -1;
let burstUntilMs = 0;
let demoTick = 0;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pulseHeartbeat(ok: boolean, msg: string) {
  const dot = el("hbDot");
  const sync = el("syncStatus");
  dot.className = ok ? "hb-dot ok pulse" : "hb-dot err";
  sync.className = ok ? "sync-status" : "sync-status err";
  sync.textContent = msg;
  if (ok) {
    setTimeout(() => dot.classList.remove("pulse"), 250);
  }
}

function buildDemoTelemetry(tick: number): TelemetryData {
  const now = new Date();
  const timeStr = (offsetSec: number) => {
    const d = new Date(now.getTime() - offsetSec * 1000);
    return d.toLocaleTimeString("en-GB", { hour12: false });
  };
  const calls = 42 + tick * 3;
  const s0 = 0.56 + ((tick * 13) % 42) / 100;
  const s1 = 0.82 + ((tick * 7) % 17) / 100;
  const s2 = 0.58 + ((tick * 19) % 39) / 100;
  const advising = tick % 5 === 0 || tick % 5 === 1;
  const activeTrig = Math.floor(tick / 5) % 3;
  const advices = [
    ["» plan skips auth edge case", "» split into 2 PRs"],
    ["» wrong fixture, not the code", "» check mock seed"],
    ["» run migration + 1 unit test", "» diff approved"],
  ];
  const p0 = Math.min(100, (tick * 17) % 115);
  const p1 = Math.min(100, ((tick + 2) * 23) % 115);
  const p2 = Math.min(100, ((tick + 4) * 14) % 115);
  const ctxTok = 112000 + tick * 1800;

  return {
    timestamp: now.toISOString(),
    stepSeq: tick,
    conversationId: "demo-session",
    conversationTitle: "demo · flow simulation",
    conversations: [],
    metrics: {
      contextTokens: ctxTok,
      contextLimit: 1_000_000,
      contextPct: Number(((ctxTok / 1_000_000) * 100).toFixed(1)),
      cacheHitPct: 88 + (tick % 9),
      tps: 54 + (tick % 24),
      lastLatencyMs: 1200 + (tick % 4) * 450,
      inFlightTools: 2,
    },
    layer0: {
      status: tick % 4 === 0 ? "active" : "standby",
      model: tick % 4 === 0 ? "ollama:qwen3" : "127.0.0.1 · standby",
      endpoint: "127.0.0.1:11434",
    },
    mcpLayer: {
      mode: "jev",
      totalCalls: calls,
      status: "routing",
      meters: [
        { key: "choice", label: "which file", score: s0, mode: s0 >= 0.75 ? "sharp" : "split", count: 18 },
        { key: "noul", label: "which tool", score: s1, mode: s1 >= 0.75 ? "sharp" : "split", count: 14 },
        { key: "score", label: "retry/stop", score: s2, mode: s2 >= 0.75 ? "sharp" : "split", count: 10 },
      ],
    },
    mainLayer: {
      model: "Gemini 4 Neon",
      rawModel: "gemini-4-neon",
      status: "swarming",
      steps: 42 + tick,
      toolCalls: 19 + tick,
      inputTokens: 184000 + tick * 2400,
      cacheReadTokens: 310000 + tick * 4200,
      outputTokens: 14200 + tick * 300,
      totalTokens: 508200 + tick * 6900,
      lastTool: ["edit_file", "run_command", "invoke_subagent"][tick % 3],
      parallelMode: "subagents",
      subagents: [
        { id: "d1", role: "search", type: "research", model: "flash", status: p0 >= 100 ? "done" : "running", progress: p0, steps: 6, lastTool: "grep" },
        { id: "d2", role: "browser", type: "browser", model: "flash", status: p1 >= 100 ? "done" : "running", progress: p1, steps: 9, lastTool: "screenshot" },
        { id: "d3", role: "audit", type: "worktree", model: "flash", status: p2 >= 100 ? "done" : "running", progress: p2, steps: 4, lastTool: "diff" },
      ],
      recentTools: [],
    },
    advisorLayer: {
      calls: 2 + Math.floor(tick / 5),
      status: advising ? "advising" : "on call",
      activeTrigger: advising ? activeTrig : -1,
      lastAdvice: advices[activeTrig],
      tokensRead: ctxTok,
    },
    pulses: {
      local_active: tick % 4 === 0,
      mcp_active: true,
      main_active: true,
      fanout_active: true,
      return_active: p0 >= 100 || p1 >= 100 || p2 >= 100,
      advisor_active: advising,
    },
    timeline: Array.from({ length: 24 }, (_, idx) => {
      const layers = ["user", "mcp", "main", "swarm", "main", "advisor", "mcp", "main"];
      return {
        layer: layers[(idx + tick) % layers.length],
        height: 28 + ((idx * 17 + tick * 11) % 70),
        label: "step",
      };
    }),
    logs: [
      { time: timeStr(9), actor: "mcp", label: "router", detail: "which file -> src/auth.ts", meta: `p=${s0.toFixed(2)} ${s0 >= 0.75 ? "sharp" : "split"}`, tone: s0 >= 0.75 ? "sharp" : "split" },
      { time: timeStr(6), actor: "subagent", label: "search", detail: "mapped 4 modules in repo", meta: `${p0}%`, tone: "info" },
      { time: timeStr(4), actor: "advisor", label: "audit", detail: advices[activeTrig][0].replace("» ", ""), meta: advising ? "advising" : "on call", tone: "info" },
      { time: timeStr(2), actor: "mcp", label: "score", detail: "retry/stop -> continue", meta: `p=${s2.toFixed(2)} ${s2 >= 0.75 ? "sharp" : "split"}`, tone: s2 >= 0.75 ? "sharp" : "split" },
      { time: timeStr(0), actor: "main", label: "edit_file", detail: "applied verified fix", meta: "+42 tok", tone: "sharp" },
    ],
  };
}

function updateSessionSelect(data: TelemetryData) {
  const select = el<HTMLSelectElement>("sessionSelect");
  if (!data.conversations || data.conversations.length === 0) return;
  const currentVal = select.value;
  const opts = [`<option value="auto">auto (latest)</option>`];
  for (const c of data.conversations) {
    const label = `${c.shortId} · ${c.title.slice(0, 14)}`;
    opts.push(`<option value="${escapeHtml(c.id)}">${escapeHtml(label)}</option>`);
  }
  select.innerHTML = opts.join("");
  select.value = currentVal;
}

function render(data: TelemetryData) {
  const nowMs = Date.now();
  if (mode === "live" && data.stepSeq !== lastStepSeq) {
    if (lastStepSeq !== -1) {
      burstUntilMs = nowMs + 6000;
    }
    lastStepSeq = data.stepSeq;
  }
  const inBurst = mode === "demo" || nowMs < burstUntilMs;

  el("winTitle").textContent =
    mode === "demo"
      ? "~/antigravity · flow · DEMO"
      : `~/antigravity · ${data.conversationId ? data.conversationId.slice(0, 8) : "idle"} · live`;
  el("cliCmd").textContent =
    mode === "demo"
      ? "agy-flow-monitor --demo"
      : `agy-flow-monitor --session ${data.conversationId ? data.conversationId.slice(0, 8) : "auto"}`;

  // Metrics Strip
  const m = data.metrics;
  el("ctxPct").textContent = `${m.contextPct}%`;
  el("ctxVal").textContent = `${formatTokens(m.contextTokens)} / ${formatTokens(m.contextLimit)}`;
  const ctxFill = el("ctxFill");
  ctxFill.style.width = `${Math.min(100, Math.max(2, m.contextPct))}%`;
  ctxFill.style.background =
    m.contextPct > 85 ? "var(--red)" : m.contextPct > 65 ? "var(--yellow)" : "var(--green)";
  el("cacheVal").textContent = `${m.cacheHitPct}%`;
  el("tpsVal").textContent = m.tps > 0 ? `${m.tps} t/s` : "-- t/s";
  el("latVal").textContent =
    m.lastLatencyMs > 0 ? `${(m.lastLatencyMs / 1000).toFixed(1)}s` : "--s";

  // Local LLM
  el("l0Box").classList.toggle("active", data.layer0.status === "active");
  el("l0State").textContent = data.layer0.status;
  el("l0Model").textContent = `${data.layer0.endpoint} · ${data.layer0.model}`;

  // Advisor / Audit Rail
  const isAdvising = data.advisorLayer.status === "advising";
  el("advisorBox").classList.toggle("advising", isAdvising);
  el("advisorStatus").textContent = data.advisorLayer.status;
  el("advisorCalls").textContent = String(data.advisorLayer.calls);
  el("advisorTokens").textContent = formatTokens(data.advisorLayer.tokensRead);
  el("advisorAdvice").innerHTML =
    data.advisorLayer.lastAdvice.length > 0
      ? data.advisorLayer.lastAdvice.map((l) => escapeHtml(l)).join("<br>")
      : "» silent on routine turns";

  el("advisorTriggers")
    .querySelectorAll(".trigger-item")
    .forEach((node, idx) => {
      const active = idx === data.advisorLayer.activeTrigger;
      node.classList.toggle("active", active);
      const diamond = node.querySelector("span");
      if (diamond) diamond.textContent = active ? "◆" : "◇";
    });

  // Main Agent
  const isMainActive =
    inBurst ||
    data.pulses.main_active ||
    data.mainLayer.status === "executing" ||
    data.mainLayer.status === "swarming";
  el("mainNode").classList.toggle("pulsing", isMainActive);
  el("mainModel").textContent = `${data.mainLayer.model} · main`;
  el("mainStatus").textContent = `[${data.mainLayer.status}]`;
  el("mainLastTool").textContent = data.mainLayer.lastTool || "-";
  el("mainTokens").textContent = formatTokens(data.mainLayer.totalTokens);

  // MCP / Routing Layer
  el("mcpNode").classList.toggle("pulsing", data.pulses.mcp_active);
  el("mcpTitle").textContent =
    data.mcpLayer.mode === "jev" ? "JEV · fork layer" : "MCP · tool router";
  el("mcpCalls").textContent = data.mcpLayer.totalCalls.toLocaleString();
  data.mcpLayer.meters.forEach((meter, idx) => {
    const lbl = el(`mLbl${idx}`);
    const fill = el(`mFill${idx}`);
    const val = el(`mVal${idx}`);
    if (!lbl || !fill || !val) return;
    lbl.textContent = meter.label;
    const pct = meter.score !== null ? Math.round(meter.score * 100) : 0;
    fill.style.width = `${pct}%`;
    fill.className = `meter-fill ${meter.mode}`;
    val.className = `meter-val ${meter.mode}`;
    if (meter.score === null) {
      val.textContent = "-- idle";
    } else if (data.mcpLayer.mode === "jev") {
      val.textContent = `${meter.score.toFixed(2)} ${meter.mode}`;
    } else {
      val.textContent = `${meter.count} calls`;
    }
  });

  // 3-Slot Parallel Fan-out
  const isToolMode = data.mainLayer.parallelMode === "tools";
  el("fanoutLabel").textContent = isToolMode
    ? "parallel tool execution"
    : "delegate to subagents · parallel";

  const sourceList = isToolMode
    ? data.mainLayer.recentTools
    : data.mainLayer.subagents;
  const slots: WorkerCard[] = [...sourceList];
  const fallbackNames = isToolMode
    ? ["tool-1", "tool-2", "tool-3"]
    : ["browser", "research", "audit"];
  while (slots.length < 3) {
    const idx = slots.length;
    slots.push({
      id: `empty-${idx}`,
      role: fallbackNames[idx],
      type: "standby",
      model: "-",
      status: "idle",
      progress: 0,
      steps: 0,
      lastTool: "",
    });
  }

  el("swarmGrid").innerHTML = slots
    .slice(0, 3)
    .map((s) => {
      const modeCls = isToolMode ? "tool-card" : "";
      const cls =
        s.status === "running"
          ? "running"
          : s.status === "idle"
            ? "idle"
            : "";
      const stCls =
        s.status === "running" ? "running" : s.status === "done" ? "done" : "";
      const stLabel =
        s.status === "running"
          ? "● running"
          : s.status === "done"
            ? "✓ done"
            : "○ idle";
      return `
        <div class="sub-card ${modeCls} ${cls}">
          <div class="sub-name" title="${escapeHtml(s.role)}">${escapeHtml(s.role)}</div>
          <div class="sub-type" title="${escapeHtml(s.type)}">${escapeHtml(s.type)}</div>
          <div class="sub-bar-wrap">
            <div class="sub-track"><div class="sub-fill" style="width:${s.progress}%"></div></div>
            <span class="sub-pct">${s.progress}%</span>
          </div>
          <div class="sub-status ${stCls}">${stLabel}</div>
        </div>
      `;
    })
    .join("");

  // SVG Packet Pulses
  const pktColor = isToolMode ? "#f28b50" : "#58a6ff";
  ["pktSub0", "pktSub1", "pktSub2"].forEach((id) =>
    el(id).setAttribute("fill", pktColor)
  );
  el("pktMcp").classList.toggle(
    "active",
    inBurst || data.pulses.mcp_active || isMainActive
  );
  el("pktSub0").classList.toggle(
    "active",
    (inBurst || data.pulses.fanout_active) && slots[0].status !== "idle"
  );
  el("pktSub1").classList.toggle(
    "active",
    (inBurst || data.pulses.fanout_active) && slots[1].status !== "idle"
  );
  el("pktSub2").classList.toggle(
    "active",
    (inBurst || data.pulses.fanout_active) && slots[2].status !== "idle"
  );
  el("pktReturn").classList.toggle(
    "active",
    inBurst || data.pulses.return_active
  );

  // Activity Timeline
  const tlBars = el("timelineBars");
  if (data.timeline && data.timeline.length > 0) {
    tlBars.innerHTML = data.timeline
      .map(
        (t) =>
          `<div class="tl-bar ${escapeHtml(t.layer)}" style="height:${t.height}%" title="${escapeHtml(t.label)}"></div>`
      )
      .join("");
  }

  // Session Log
  el("logSteps").textContent = `${data.mainLayer.steps} steps · ${data.mainLayer.toolCalls} tools`;
  const logList = el("logList");
  if (data.logs.length > 0) {
    logList.innerHTML = data.logs
      .map(
        (l) => `
      <div class="log-row">
        <span class="log-time">${escapeHtml(l.time)}</span>
        <span class="log-actor ${escapeHtml(l.actor)}">${escapeHtml(l.actor)}</span>
        <span class="log-detail">${escapeHtml(l.label)} → ${escapeHtml(l.detail)}</span>
        <span class="log-meta ${escapeHtml(l.tone || "")}">${escapeHtml(l.meta || "")}</span>
      </div>`
      )
      .join("");
    logList.scrollTop = logList.scrollHeight;
  }

  // Status Bar
  const activeSubs = data.mainLayer.subagents.filter(
    (s) => s.status === "running"
  ).length;
  el("sbLocal").textContent = `[${data.layer0.status}]`;
  el("sbMcp").textContent = `[${data.mcpLayer.totalCalls.toLocaleString()}]`;
  el("sbSwarm").textContent = isToolMode
    ? `[${data.metrics.inFlightTools} tools]`
    : `[${activeSubs}/${data.mainLayer.subagents.length}]`;
  el("sbAdvisor").textContent = `[${data.advisorLayer.status}]`;
}

// MCP App Initialization
const app = new App({ name: "AGY Flow Monitor", version: "1.0.0" }, {});

app.ontoolinput = () => {};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent as TelemetryData | undefined;
  if (sc && sc.mainLayer) {
    latestLiveData = sc;
    updateSessionSelect(sc);
    if (mode === "live") render(sc);
    pulseHeartbeat(
      true,
      `sync: init (${new Date().toLocaleTimeString("en-GB", { hour12: false })})`
    );
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

el("railBtn").addEventListener("click", () => {
  railVisible = !railVisible;
  el("stage").classList.toggle("rail-hidden", !railVisible);
});

el("modeBtn").addEventListener("click", () => {
  const btn = el("modeBtn");
  if (mode === "live") {
    mode = "demo";
    btn.textContent = "DEMO";
    btn.className = "mode-btn demo-active";
    render(buildDemoTelemetry(demoTick));
  } else {
    mode = "live";
    btn.textContent = "LIVE";
    btn.className = "mode-btn live-active";
    if (latestLiveData) render(latestLiveData);
  }
});

el("sessionSelect").addEventListener("change", (ev) => {
  selectedConvId = (ev.target as HTMLSelectElement).value;
  lastStepSeq = -1;
  if (mode === "live") void pollOnce();
});

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const res = await app.callServerTool({
      name: "poll_telemetry",
      arguments: { conversationId: selectedConvId },
    });
    const sc = res?.structuredContent as TelemetryData | undefined;
    if (sc && sc.mainLayer) {
      pollCount += 1;
      latestLiveData = sc;
      if (
        selectedConvId === "auto" &&
        el<HTMLSelectElement>("sessionSelect").options.length <= 1
      ) {
        updateSessionSelect(sc);
      }
      if (mode === "live") render(sc);
      const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
      pulseHeartbeat(true, `sync: #${pollCount} · ${t}`);
    } else {
      pulseHeartbeat(false, "sync: empty payload");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pulseHeartbeat(false, `err: ${msg.slice(0, 28)}`);
  } finally {
    pollInFlight = false;
  }
}

async function boot() {
  try {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pulseHeartbeat(false, `connect err: ${msg.slice(0, 22)}`);
  }

  await pollOnce();
  setInterval(() => {
    if (mode === "demo") {
      demoTick += 1;
      render(buildDemoTelemetry(demoTick));
      pulseHeartbeat(true, `demo tick #${demoTick}`);
    } else {
      void pollOnce();
    }
  }, 1100);
}

void boot();
