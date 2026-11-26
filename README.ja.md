<div align="center">

# AGY Flow Monitor

**Google Antigravity 向け ゼロ依存・リアルタイム実行フロー＆テレメトリ監視サイドペインダッシュボード**

[![English](https://img.shields.io/badge/Language-English-2563EB?style=for-the-badge)](./README.md)
[![日本語](https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-Japanese-10B981?style=for-the-badge)](./README.ja.md)
[![简体中文](https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-Chinese-F59E0B?style=for-the-badge)](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-22C55E?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Runtime Dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-38BDF8?style=flat-square)](#インストール)
[![100% Local](https://img.shields.io/badge/privacy-100%25%20local-A78BFA?style=flat-square)](#セキュリティとプライバシー)

</div>

---

## 概要

**AGY Flow Monitor** は、**Google Antigravity** のサイドペイン（および左サイドバー全画面ビュー）に直接埋め込める **MCP App プラグイン** です。

ローカルの会話ログ（`transcript.jsonl`）をリアルタイム監視し、メインモデルの稼働状態・コンテキスト使用率・キャッシュヒット率・並列ツール実行・サブエージェント並列稼働・MCPルーティングを、ダークターミナル風のフロー図と光点アニメーションで可視化します。**ランタイム依存ゼロ・`npm install` 不要・外部通信ゼロ** で動作します。

---

## 主な機能

- **リアルタイム・メトリクスバー**
  - **CONTEXT**: モデル別のコンテキスト上限を自動判定（Gemini `1M` / Claude `200K` / GPT-4o `128K`）して使用率ゲージを表示
  - **CACHE**: プロンプトキャッシュヒット率（`cache_read_tokens / active_context`）
  - **SPEED / LATENCY**: 推定出力速度（tok/s）とステップ遅延時間
- **アニメーション付き実行フロー図**
  - **メインエージェント**: 使用モデル名・状態（`ready` / `executing` / `swarming`）・直近ツール・累計トークン
  - **汎用 MCP ルーター**: 呼び出された任意の MCP サーバー上位3件を自動集計（`typesafe-ai` / JEV を検出した場合は信頼度メーター表示へ自動切替）
  - **3スロット並列ファンアウト**: サブエージェント並列稼働（`browser` / `research` 等）と通常ツールの並列実行（`search_web` / `read_file` / `run_command` 等）を自動切替し、進捗バーと発光パケットで描画
  - **折りたたみ可能なサイドレール（`RAIL` ボタン）**: Audit/Advisor 系 MCP とローカル LLM（Ollama `11434` / llama.cpp `8080`）の状態を表示。使わない環境では折りたたんでメインフローを全幅表示可能
- **アクティビティ・タイムライン＆セッションログ**
  - 直近28ステップをレイヤー別カラーで表示するスパークライン
  - タイムスタンプ付き `session log` と同期心拍インジケータ（`sync: #N · HH:MM:SS`）
- **`LIVE / DEMO` 切替ボタン**
  - アイドル中でも `DEMO` に切り替えることで、全レイヤーのアニメーション動作を即座にプレビュー可能

---

## インストール

**動作要件:** Node.js `>= 20`（ビルド済み単一ファイルを `dist/` に同梱しているため `npm install` は不要です）

### Windows (PowerShell)

```powershell
git clone https://github.com/qryuu/agy-flow-monitor.git "$env:USERPROFILE\.gemini\config\plugins\agy-flow-monitor"
```

### macOS / Linux

```bash
git clone https://github.com/qryuu/agy-flow-monitor.git ~/.gemini/config/plugins/agy-flow-monitor
```

### 開き方

1. `~/.gemini/config/plugins/` に配置すると Antigravity が自動認識します（再起動不要）。
2. サイドペインの **`+` メニュー**（または左サイドバー）から **`AGY Flow Monitor`** を選択してください。
3. 見つからない場合は、Antigravity の **MCP Servers 設定** からリフレッシュしてください。

---

## オプション環境変数

`mcp_config.json` の `"env"` で挙動をカスタマイズできます：

| 環境変数 | 内容 | デフォルト |
|---|---|---|
| `AGY_MONITOR_NO_LOCAL_PROBE` | `"1"` にすると `127.0.0.1` のローカル LLM 死活確認を無効化 | 未設定 |
| `AGY_BRAIN_DIR` | Antigravity の `brain` ディレクトリパスを手動指定 | `~/.gemini/antigravity/brain` |
| `AGY_MONITOR_HTML` | 開発時に任意の `app.html` を直接読み込むパス | `dist/app.html` |

---

## ソースからのビルド

```bash
npm install
npm run build
```

`dist/server.mjs`（ゼロ依存 Node ESM）と `dist/app.html`（JS構文検証済み単一HTML）が生成されます。

---

## セキュリティとプライバシー

- **100% ローカル動作**: ローカル Stdio MCP のみで完結し、会話ログやプロンプトを外部サーバーへ一切送信しません。
- **自動アップデートなし**: バックグラウンドでの自動ダウンロードやコード差し替えは行いません。
- **読み取り専用**: ローカルのログファイルと（任意で）ローカルホストの死活確認エンドポイントのみを参照します。

---

## ライセンス

[MIT](./LICENSE)
