<div align="center">

<img src="https://media.valorant-api.com/agents/df1cb487-4902-002e-5c17-d28e83e78588/displayicon.png" width="160" />

# Waylay

**Lightweight, fast, pure-JS headless NTQQ bridge with built-in Milky support**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18-green.svg)](https://nodejs.org/)
[![QQ Version](https://img.shields.io/badge/QQ-3.2.31-blue.svg)](https://im.qq.com/linuxqq/index.shtml)
[![Milky](https://img.shields.io/badge/Milky-v1-purple.svg)](#milky-protocol)
[![Dependencies](https://img.shields.io/badge/deps-1_(ws)-brightgreen.svg)](#highlights)

[中文](README.md)

</div>

---

## About

Waylay is a lightweight headless NTQQ bridge written in plain JavaScript with built-in Milky protocol support. It loads QQ's `wrapper.node` native module directly to communicate with the QQ kernel — ideal for minimal deployments with low resource requirements.

## Highlights

- **Lightweight** — Plain JavaScript with 1 runtime dependency (`ws`)
- **Fast queries** — Event-driven in-memory cache, sub-millisecond read responses
- **Non-blocking I/O** — Async media downloads, never blocks message processing
- **Simple architecture** — Direct `wrapper.node` calls, no extra abstraction layers
- **Low resource usage** — Single-process, no WebUI / database / logging framework overhead
- **Milky protocol** — Built-in Milky protocol support (HTTP API + WebSocket/SSE/Webhook events)
- **Quick login** — Supports QQ number quick login, skip QR code on container restart
- **Bridge protocol compatible** — Exposes low-level Bridge WebSocket protocol (port 13000) and QR code endpoint (`/qrcode`)

## How It Works

```
Bot Framework ←→ Waylay (Milky) ←→ wrapper.node ←→ QQ Server
```

1. Runs inside QQ's Electron process (patched `package.json` entry point)
2. Loads NTQQ's `wrapper.node` native module directly
3. Initializes QQ kernel, handles login (QR code or quick login)
4. Registers kernel event listeners (messages, groups, friends, etc.)
5. Exposes Milky protocol (HTTP/WS/SSE) and Bridge WebSocket (port 13000)

## Installation

### Option 1: Docker Hub (Recommended)

```bash
docker run -d --name waylay \
  -p 13000:13000 -p 8082:8082 \
  -e MILKY_HTTP_PORT=8082 \
  micuks/waylay:latest
```

Then visit `http://localhost:13000/qrcode` to scan the QR code and log in.

With parameters (quick login + auth token):

```bash
docker run -d --name waylay \
  -p 13000:13000 -p 8082:8082 \
  -e AUTO_LOGIN_QQ=123456789 \
  -e MILKY_HTTP_PORT=8082 \
  -e MILKY_TOKEN=your_token \
  -v waylay_qq:/home/node/.config/QQ \
  micuks/waylay:latest
```

Or use Docker Compose:

```bash
curl -fsSLO https://raw.githubusercontent.com/Micuks/waylay-qq-bridge/master/docker-compose.yml
# Edit docker-compose.yml as needed
docker compose up -d
```

### Option 2: Install Script (Bare-metal Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Micuks/waylay-qq-bridge/master/install.sh | sudo bash
```

After installation:

```bash
sudo systemctl start waylay    # Start
sudo systemctl enable waylay   # Auto-start on boot
curl http://localhost:13000/qrcode  # View login QR code
journalctl -u waylay -f        # View logs
```

### Option 3: Build from Source

```bash
git clone https://github.com/Micuks/waylay-qq-bridge.git
cd waylay-qq-bridge
docker compose up -d --build
```

**Windows users**: See the [WSL Installation Guide](docs/wsl-guide.md)

### Quick Login

Set the `AUTO_LOGIN_QQ` environment variable to skip QR code scanning:

```yaml
environment:
  - AUTO_LOGIN_QQ=123456789
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `13000` | Bridge WS/HTTP server port |
| `BRIDGE_HOST` | `0.0.0.0` | Listen address |
| `AUTO_LOGIN_QQ` | — | QQ number for quick login |
| `MILKY_HTTP_PORT` | `0` | Milky HTTP/WS/SSE port (0 = disabled) |
| `MILKY_HOST` | `0.0.0.0` | Milky listen address |
| `MILKY_TOKEN` | — | Access token for Milky auth |
| `MILKY_WEBHOOK_URLS` | `[]` | JSON array of Milky Webhook URLs |

## Supported QQ Versions

| Version | Platform | Status |
|---------|----------|--------|
| QQ 3.2.31 (Linux amd64) | Docker / Linux | Verified |

> Waylay detects the installed QQ version on startup and loads a matching adaptation profile
> (`src/qq-profiles.js`): `>=3.2.27` is built in, and newer versions are auto-probed. It loads
> NTQQ's `wrapper.node` and should work with any QQ Linux version that includes this module.

## Comparison

The QQ Bot ecosystem has several excellent open-source projects, each with its own strengths. Here is an objective comparison to help you choose:

| | **Waylay** | **NapCatQQ** | **LLOneBot** | **Lagrange.Core** |
|---|---|---|---|---|
| **Language** | JavaScript | TypeScript | TypeScript | C# |
| **Source size** | ~4,000 lines / 13 files | ~3 MB / 832 files | ~1.7 MB / 529 files | ~1.4 MB / 1,027 files |
| **Runtime deps** | 1 (`ws`) | ~30 npm packages | 23 npm packages | 6 NuGet packages |
| **node_modules** | 208 KB | ~100+ MB | ~80+ MB | N/A (.NET) |
| **Approach** | Direct wrapper.node loading | process.dlopen wrapper.node | PMHQ memory injection + WebSocket | Protocol reimplementation |
| **Requires QQ** | Yes | Yes | Yes (+ PMHQ) | No |
| **Status** | Active | Active | Active | Archived (2025) |

> Each project has its own design philosophy. NapCatQQ is feature-rich with a mature ecosystem; LLOneBot (LuckyLilliaBot) supports multiple protocol adapters; Lagrange.Core needs no QQ client. Waylay focuses on minimalism, suitable for resource-constrained or simplicity-oriented deployments.

### Query Latency Reference (Waylay vs LLOneBot, 10-round avg)

| Action | Waylay | LLOneBot | Note |
|--------|--------|----------|------|
| `get_login_info` | 0.7ms | 6.3ms | |
| `get_friend_list` | 1.0ms | 47.9ms | |
| `get_group_list` | 0.8ms | 27.3ms | |
| `get_group_info` | 0.6ms | 28.4ms | |
| `get_group_member_list` | 1.0ms | 10.2ms | |
| `get_group_member_info` | 0.5ms | 12.0ms | |
| `send_group_msg` | 403ms | 457ms | QQ server bound |

> Waylay's query speed advantage comes from its event-driven in-memory cache design. Message sending latency is comparable — both are bounded by QQ server network round-trip.

### Architecture Overview

```
NapCatQQ:
  Bot Framework ←→ NapCat-OneBot ←→ NapCat-Core ←→ wrapper.node ←→ QQ Server

LLOneBot:
  Bot Framework ←→ LLBot ←→ PMHQ (memory injection) ←→ QQNT ←→ QQ Server

Waylay:
  Bot Framework ←→ Waylay ←→ wrapper.node ←→ QQ Server
```

## Milky Protocol

Waylay supports the Milky protocol over HTTP API + WebSocket/SSE/Webhook events.

- **HTTP API** — `POST /api/:action`
- **SSE** — `GET /event`
- **WebSocket** — `ws://host:port/event`
- **Webhook** — Configure via `MILKY_WEBHOOK_URLS`

## Acknowledgements

Waylay is inspired by and grateful to the following projects:

- [NapCatQQ](https://github.com/NapNeko/NapCatQQ) — Feature-rich NTQQ framework
- [LLOneBot](https://github.com/LLOneBot/LLOneBot) — Multi-protocol QQ Bot solution
- [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) — Elegant C# protocol implementation
- [OneBot v11](https://github.com/botuniverse/onebot-11) — Unified Bot protocol standard

## License

[Apache License 2.0](LICENSE) — Free to use, attribution required.

Copyright 2026 Micuks
