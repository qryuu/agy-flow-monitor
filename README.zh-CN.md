<div align="center">

# AGY Flow Monitor

**适用于 Google Antigravity 的零依赖实时执行流与遥测侧边栏仪表板**

[![English](https://img.shields.io/badge/Language-English-2563EB?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-Japanese-10B981?style=for-the-badge)](./README.ja.md)
[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-Chinese-F59E0B?style=for-the-badge)](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-22C55E?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Runtime Dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-38BDF8?style=flat-square)](#安装方式)
[![100% Local](https://img.shields.io/badge/privacy-100%25%20local-A78BFA?style=flat-square)](#安全与隐私)

</div>

---

## 简介

**AGY Flow Monitor** 是一款可直接嵌入 **Google Antigravity** 侧边栏（以及左侧全局视图）的 **MCP App 插件**。

它实时读取本地会话日志（`transcript.jsonl`），以深色终端风格的动态流程图呈现主模型状态、上下文窗口占比、缓存命中率、并行工具调用、子代理（Subagent）并发以及 MCP 路由状态。**零运行时依赖、无需 `npm install`、100% 本地运行**。

---

## 核心特性

- **实时指标条**
  - **CONTEXT**: 按模型自动识别上下文上限（Gemini `1M` / Claude `200K` / GPT-4o `128K`）并展示彩色进度条
  - **CACHE**: 提示词缓存命中率（`cache_read_tokens / active_context`）
  - **SPEED / LATENCY**: 估算输出速度（tok/s）与步骤响应延迟
- **动态执行流程图**
  - **主代理节点**: 实时显示当前模型、状态（`ready` / `executing` / `swarming`）、最近工具与累计 Token
  - **自适应 MCP 路由器**: 自动统计最活跃的前 3 个 MCP 服务器调用（检测到 `typesafe-ai` / JEV 时自动切换为置信度条模式）
  - **3 槽位并行扇出**: 自动在**子代理并发**（`browser`、`research` 等）与**并行工具执行**（`search_web`、`read_file`、`run_command` 等）之间切换，配合进度条与发光 SVG 数据包动画
  - **可折叠侧栏（`RAIL` 按钮）**: 展示审查/顾问型 MCP 及本地大模型（Ollama `11434` / llama.cpp `8080`）状态；不使用时可一键折叠，让主流程图占满宽度
- **活动时间线与实时会话日志**
  - 最近 28 步的分层彩色迷你柱状图
  - 带时间戳自动滚动的 `session log` 及心跳同步指示器（`sync: #N · HH:MM:SS`）
- **内置 `LIVE / DEMO` 切换**
  - 空闲时也可随时切换到 `DEMO` 模式预览完整动画效果

---

## 安装方式

**环境要求:** Node.js `>= 20`（`dist/` 目录已内置零依赖单文件产物，无需执行 `npm install`）。

### Windows (PowerShell)

```powershell
git clone https://github.com/qryuu/agy-flow-monitor.git "$env:USERPROFILE\.gemini\config\plugins\agy-flow-monitor"
```

### macOS / Linux

```bash
git clone https://github.com/qryuu/agy-flow-monitor.git ~/.gemini/config/plugins/agy-flow-monitor
```

### 打开方式

1. 放入 `~/.gemini/config/plugins/` 后，Antigravity 会自动识别插件（无需重启）。
2. 点击 Antigravity **侧边栏的 `+` 按钮**（或左侧导航栏），选择 **`AGY Flow Monitor`**。
3. 如未立即显示，请在 Antigravity 的 **MCP Servers** 设置中刷新即可。

---

## 可选环境变量

可在 `mcp_config.json` 中通过 `"env"` 配置：

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `AGY_MONITOR_NO_LOCAL_PROBE` | 设为 `"1"` 可关闭对 `127.0.0.1:11434` / `8080` 的本地大模型探测 | 未设置 |
| `AGY_BRAIN_DIR` | 自定义 Antigravity `brain` 目录路径 | `~/.gemini/antigravity/brain` |
| `AGY_MONITOR_HTML` | 开发调试时指定自定义 `app.html` 路径 | `dist/app.html` |

---

## 从源码构建

```bash
npm install
npm run build
```

将自动打包零依赖的 `dist/server.mjs` 与经过 JS 语法校验的单文件 `dist/app.html`。

---

## 安全与隐私

- **100% 本地运行**: 仅通过本地 Stdio MCP 通信，绝不向任何外部服务器上传对话记录或遥测数据。
- **无自动更新**: 不进行后台下载或静默替换代码。
- **只读访问**: 仅读取本地日志及（可选的）本机回环健康检查端口。

---

## 许可证

[MIT](./LICENSE)
