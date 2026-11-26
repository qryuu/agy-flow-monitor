import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearTelemetryCaches,
  collectTelemetry,
  getContextLimit,
  inspectSubagentTranscript,
  listConversations,
  readFirstLine,
  readTranscriptIncremental,
} from "../src/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function makeTempBrain() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-flow-test-"));
}

function writeTranscript(brainDir, convId, lines) {
  const logDir = path.join(brainDir, convId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const tPath = path.join(logDir, "transcript.jsonl");
  fs.writeFileSync(tPath, lines.join("\n") + "\n", "utf8");
  return tPath;
}

test("getContextLimit returns model-appropriate limits", () => {
  assert.equal(getContextLimit("gemini-4-neon-medium"), 1_000_000);
  assert.equal(getContextLimit("claude-sonnet-5.5"), 200_000);
  assert.equal(getContextLimit("claude-opus-1m"), 1_000_000);
  assert.equal(getContextLimit("gpt-4o-mini"), 128_000);
  assert.equal(getContextLimit("o3-high"), 200_000);
  assert.equal(getContextLimit(""), 1_000_000);
});

test("listConversations & readFirstLine handle missing/unreadable paths safely", () => {
  assert.deepEqual(listConversations(path.join(os.tmpdir(), "non-existent-brain-xyz")), []);
  assert.equal(readFirstLine(path.join(os.tmpdir(), "non-existent-file-xyz.jsonl")), "");
});

test("readTranscriptIncremental handles cache hit, split partial-line writes, and truncation", () => {
  clearTelemetryCaches();
  const brain = makeTempBrain();
  try {
    const tPath = writeTranscript(brain, "conv-inc", [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>hello</USER_REQUEST>" }),
      "{broken-json-line-should-be-skipped",
    ]);

    const r1 = readTranscriptIncremental(tPath);
    assert.equal(r1.cacheHit, false);
    assert.equal(r1.steps.length, 1);

    // Unchanged mtime/size -> cache hit
    const r2 = readTranscriptIncremental(tPath);
    assert.equal(r2.cacheHit, true);
    assert.equal(r2.steps.length, 1);

    // Partial JSON line written without newline (mid-write poll)
    const fullLine = JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      model: "gemini-4-neon",
      input_tokens: 1000,
      cache_read_tokens: 4000,
      output_tokens: 200,
    });
    const half = Math.floor(fullLine.length / 2);
    fs.appendFileSync(tPath, fullLine.slice(0, half), "utf8");

    const rPartial = readTranscriptIncremental(tPath);
    assert.equal(rPartial.cacheHit, false);
    assert.equal(rPartial.steps.length, 1); // partial line not lost, waiting for remainder

    // Complete the partial line on next write
    fs.appendFileSync(tPath, fullLine.slice(half) + "\n", "utf8");
    const rComplete = readTranscriptIncremental(tPath);
    assert.equal(rComplete.cacheHit, false);
    assert.equal(rComplete.steps.length, 2);
    assert.equal(rComplete.steps[1].output_tokens, 200);

    // Truncation (file shrinks) -> clean cold reload
    fs.writeFileSync(
      tPath,
      JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>reset</USER_REQUEST>" }) + "\n",
      "utf8"
    );
    const rTrunc = readTranscriptIncremental(tPath);
    assert.equal(rTrunc.cacheHit, false);
    assert.equal(rTrunc.steps.length, 1);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test("readTranscriptIncremental caps cold read (>4MiB) and rolling step window (<=500)", () => {
  clearTelemetryCaches();
  const brain = makeTempBrain();
  try {
    const pad = "x".repeat(8500);
    const lines = [];
    // ~550 lines * ~8.6 KB ≈ 4.7 MiB (> 4 MiB cap AND > 500 step cap)
    for (let i = 0; i < 550; i++) {
      lines.push(JSON.stringify({ step_index: i, type: "GENERIC", content: pad }));
    }
    const tPath = writeTranscript(brain, "conv-large", lines);
    assert.ok(fs.statSync(tPath).size > 4 * 1024 * 1024, "fixture must exceed 4 MiB");

    const res = readTranscriptIncremental(tPath);
    assert.ok(res.steps.length > 0 && res.steps.length <= 500, `expected <=500 steps, got ${res.steps.length}`);
    assert.equal(res.steps[res.steps.length - 1].step_index, 549);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test("collectTelemetry switches to JEV mode on typesafe-ai calls and tracks parallel tools", async () => {
  clearTelemetryCaches();
  const brain = makeTempBrain();
  try {
    const nowIso = new Date().toISOString();
    writeTranscript(brain, "conv-jev", [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: nowIso, content: "<USER_REQUEST>audit repo</USER_REQUEST>" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        model: "claude-sonnet-5.5",
        input_tokens: 10_000,
        cache_read_tokens: 90_000,
        output_tokens: 400,
        tool_calls: [
          { name: "call_mcp_tool", args: { ServerName: '"typesafe-ai"', ToolName: '"typesafe_choice"' } },
          { name: "search_web", args: { query: '"test"' } },
        ],
      }),
      JSON.stringify({ step_index: 2, type: "GENERIC", created_at: nowIso, content: '{"probability": 0.94}' }),
      JSON.stringify({ step_index: 3, type: "GENERIC", created_at: nowIso, content: "search ok" }),
    ]);

    const data = await collectTelemetry("conv-jev", { brainDir: brain, skipLocalProbe: true });
    assert.equal(data.metrics.contextLimit, 200_000);
    assert.equal(data.metrics.contextPct, 50);
    assert.equal(data.metrics.cacheHitPct, 90);
    assert.equal(data.mcpLayer.mode, "jev");
    assert.equal(data.mcpLayer.totalCalls, 1);
    assert.equal(data.mcpLayer.meters[0].score, 0.94);
    assert.equal(data.mcpLayer.meters[0].mode, "sharp");
    assert.equal(data.mainLayer.parallelMode, "tools");
    assert.ok(data.mainLayer.recentTools.length >= 1);
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test("collectTelemetry & inspectSubagentTranscript detect running subagents (>64KiB tail) and generic MCP", async () => {
  clearTelemetryCaches();
  const brain = makeTempBrain();
  try {
    const nowIso = new Date().toISOString();
    // Create a >64KiB subagent transcript ending with an active tool call
    const subLines = [];
    for (let i = 0; i < 40; i++) {
      subLines.push(JSON.stringify({ step_index: i, type: "GENERIC", content: "y".repeat(2000) }));
    }
    subLines.push(
      JSON.stringify({ step_index: 40, type: "PLANNER_RESPONSE", created_at: nowIso, tool_calls: [{ name: "read_file", args: {} }] })
    );
    const subPath = writeTranscript(brain, "sub-active-1", subLines);
    assert.ok(fs.statSync(subPath).size > 64 * 1024, "subagent fixture must exceed 64 KiB");

    const subState = inspectSubagentTranscript("sub-active-1", brain);
    assert.equal(subState.status, "running");
    assert.equal(subState.lastTool, "read_file");

    writeTranscript(brain, "conv-gen", [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: nowIso, content: "<USER_REQUEST><script>alert(1)</script></USER_REQUEST>" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        model: "gemini-4-neon",
        input_tokens: 20_000,
        cache_read_tokens: 80_000,
        output_tokens: 500,
        tool_calls: [
          { name: "call_mcp_tool", args: { ServerName: '"github"', ToolName: '"search_code"' } },
          { name: "invoke_subagent", args: { Role: '"Code Researcher"', TypeName: '"research"', Model: '"flash"' } },
        ],
      }),
      JSON.stringify({ step_index: 2, type: "GENERIC", created_at: nowIso, content: '{"conversationId": "sub-active-1"}' }),
    ]);

    const data = await collectTelemetry("conv-gen", { brainDir: brain, skipLocalProbe: true });
    assert.equal(data.mcpLayer.mode, "generic");
    assert.equal(data.mcpLayer.meters[0].label, "github");
    assert.equal(data.mcpLayer.meters[0].count, 1);
    assert.equal(data.mainLayer.subagents.length, 1);
    assert.equal(data.mainLayer.subagents[0].status, "running");
    assert.equal(data.mainLayer.parallelMode, "subagents");
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test("dist/app.html contains CSP meta tag, valid JS, and XSS-safe escaping & clampPct in src/app.ts", () => {
  const htmlPath = path.join(ROOT, "dist", "app.html");
  assert.ok(fs.existsSync(htmlPath), "dist/app.html must exist");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'), "CSP meta tag must be present");
  const s = html.indexOf("<script>");
  const e = html.indexOf("</script>", s);
  const le = html.lastIndexOf("</script>");
  assert.equal(e, le, "must have single closing </script> tag");
  const js = html.slice(s + 8, e);
  assert.doesNotThrow(() => new Function(js), "bundled JS must parse without SyntaxError");

  // Verify escapeHtml and clampPct behavior directly from src/app.ts
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "app.ts"), "utf8");
  assert.ok(appSrc.includes("function escapeHtml"), "escapeHtml must exist");
  assert.ok(appSrc.includes("function clampPct"), "clampPct must exist");
  assert.ok(appSrc.includes("width:${pct}%"), "progress width must use clamped pct");
  assert.ok(appSrc.includes("height:${clampPct(t.height)}%"), "timeline bar height must use clampPct");
  assert.ok(appSrc.includes("escapeHtml(l.detail)"), "log detail must be escaped");
  assert.ok(appSrc.includes("escapeHtml(s.role)"), "subagent role must be escaped");
});
