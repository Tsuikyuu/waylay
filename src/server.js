"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { randomUUID } = require("crypto");
const { VERSION } = require("./version");
const { getLogs, clearLogs, subscribeLogs } = require("./logger");

const SERVER_VERSION = "qq-bridge/" + VERSION;
const SERVER_START_MS = Date.now();
const WEB_ROOT = path.join(__dirname, "web");
const utf8Decoder = new TextDecoder("utf-8");

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// 判断客户端请求头是否期望 HTML 页面
function wantsHtml(req) {
  const accept = req.headers["accept"];
  if (typeof accept !== "string") return false;
  return accept.toLowerCase().includes("text/html");
}

// 安全拼接静态资源路径，阻止目录穿越
function resolveSafeWebPath(relPath) {
  const cleaned = relPath.split("?")[0].split("#")[0].replace(/^\/+/, "");
  let decoded = "";
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = path.normalize(path.join(WEB_ROOT, decoded));
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + path.sep)) {
    return null;
  }
  return full;
}

// 读取并返回静态文件
function serveStaticFile(res, fullPath) {
  fs.readFile(fullPath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = STATIC_MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

// 读取 JSON 请求体
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// 输出统一 JSON 响应
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, mapReplacer));
}

/**
 * 桥接服务与 WebUI 控制台 HTTP + WebSocket 服务器
 */
class BridgeServer {
  constructor(port, host, bridge) {
    this.port = port;
    this.host = host;
    this.bridge = bridge;
    this.wsClients = new Set();

    this.httpServer = http.createServer((req, res) => {
      this._handleHttp(req, res);
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wss.on("connection", (ws) => this._handleWsConnection(ws));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.port, this.host, () => {
        console.log(`[server] 监听地址 ${this.host}:${this.port}`);
        console.log(`[server] WebUI 控制台已就绪 -> http://${this.host}:${this.port}/`);
        resolve();
      });
      this.httpServer.on("error", reject);
    });
  }

  /** 向所有已连接的桥接 WebSocket 客户端广播消息 */
  broadcast(message) {
    const payload = JSON.stringify(message, mapReplacer);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** 将 NTQQ 内核事件推送给桥接客户端 */
  pushEvent(listenerName, eventName, data) {
    const typeMap = {
      nodeIKernelMsgListener: "on_message",
      nodeIKernelGroupListener: "on_group",
      nodeIKernelBuddyListener: "on_buddy",
      nodeIKernelProfileListener: "on_profile",
      nodeIKernelFlashTransferListener: "on_flash_file",
      nodeIKernelLoginListener: "on_login",
      nodeIKernelOnlineStatusListener: "on_online_status",
      nodeIKernelRecentContactListener: "on_recent_contact",
      nodeIKernelStorageCleanListener: "on_storage_clean",
      nodeIKernelRobotListener: "on_robot",
      nodeIKernelSearchListener: "on_search",
      nodeIKernelCollectionListener: "on_collection",
      nodeIKernelYellowFaceListener: "on_yellow_face",
      nodeIKernelFileAssistantListener: "on_file_assistant",
      nodeIKernelSessionListener: "on_session",
      nodeIKernelSettingListener: "on_setting",
      nodeIQQNTWrapperSessionListener: "on_session",
    };
    const type = typeMap[listenerName] || listenerName;
    this.broadcast({ type, data: { sub_type: eventName, data } });
  }

  // --- WebSocket 连接处理 ---

  _handleWsConnection(ws) {
    console.log("[server] Bridge WebSocket 客户端已连接");
    this.wsClients.add(ws);
    ws.on("close", () => {
      console.log("[server] Bridge WebSocket 客户端已断开");
      this.wsClients.delete(ws);
    });
    ws.on("error", (err) => {
      console.error("[server] Bridge WebSocket 错误:", err.message);
      this.wsClients.delete(ws);
    });
    ws.on("message", async (raw) => {
      let msg = null;
      try {
        const text = typeof raw === "string" ? raw : utf8Decoder.decode(raw);
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const result = await this._handleRequest(msg);
      if (result && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(result, mapReplacer));
      }
    });
  }

  // --- HTTP 路由处理 ---

  async _handleHttp(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url || "/";
    const urlPath = rawUrl.split("?")[0];

    // WebUI 控制台 API 路由
    if (urlPath.startsWith("/api/")) {
      await this._handleConsoleApi(req, res, urlPath);
      return;
    }

    // 底层 Bridge HTTP POST RPC（根路径）
    if (req.method === "POST" && urlPath === "/") {
      try {
        const msg = await readJsonBody(req);
        const result = await this._handleRequest(msg);
        sendJson(res, 200, result || {});
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid JSON");
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    // 静态资源文件（/web/*）
    if (urlPath.startsWith("/web/")) {
      const subPath = urlPath.slice(5);
      const fullPath = resolveSafeWebPath(subPath);
      if (!fullPath) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad path");
        return;
      }
      serveStaticFile(res, fullPath);
      return;
    }

    // 站点图标
    if (urlPath === "/favicon.svg" || urlPath === "/favicon.ico") {
      serveStaticFile(res, path.join(WEB_ROOT, "favicon.svg"));
      return;
    }

    // 原始二维码 PNG 端点
    if (urlPath === "/qrcode.png" || urlPath === "/qr.png") {
      this._serveQrPng(res);
      return;
    }

    // /qrcode：浏览器打开 WebUI 扫码视图，命令行工具返回原始 PNG
    if (urlPath === "/qrcode" || urlPath === "/qr") {
      if (wantsHtml(req)) {
        serveStaticFile(res, path.join(WEB_ROOT, "index.html"));
        return;
      }
      this._serveQrPng(res);
      return;
    }

    // 根路径：浏览器打开 WebUI 控制台，探针返回健康状态 JSON
    if (urlPath === "/" || urlPath === "/index.html") {
      if (wantsHtml(req)) {
        serveStaticFile(res, path.join(WEB_ROOT, "index.html"));
        return;
      }
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  // --- 控制台后端接口 ---

  async _handleConsoleApi(req, res, urlPath) {
    // 运行状态与监控指标
    if (req.method === "GET" && urlPath === "/api/status") {
      sendJson(res, 200, this._collectStatus());
      return;
    }

    // 主动请求刷新登录二维码
    if ((req.method === "POST" || req.method === "GET") &&
        (urlPath === "/api/login/refresh-qr" || urlPath === "/api/refresh-qr")) {
      const ok = this.bridge && typeof this.bridge.requestQRCode === "function"
        ? this.bridge.requestQRCode()
        : false;
      sendJson(res, ok ? 200 : 503, { ok });
      return;
    }

    // 获取本机已保存的历史登录账号列表
    if (req.method === "GET" && urlPath === "/api/login/accounts") {
      const accounts = this.bridge && typeof this.bridge.getLoginCandidates === "function"
        ? await this.bridge.getLoginCandidates()
        : [];
      sendJson(res, 200, { accounts });
      return;
    }

    // 触发指定 QQ 号快速登录
    if (req.method === "POST" && urlPath === "/api/login/quick") {
      try {
        const body = await readJsonBody(req);
        const uin = typeof body.uin === "string" ? body.uin.trim() : "";
        if (!uin) {
          sendJson(res, 400, { ok: false, message: "请输入有效的 QQ 号" });
          return;
        }
        const ok = this.bridge && typeof this.bridge.quickLoginByUin === "function"
          ? this.bridge.quickLoginByUin(uin)
          : false;
        sendJson(res, ok ? 200 : 503, { ok });
      } catch {
        sendJson(res, 400, { ok: false, message: "请求格式错误" });
      }
      return;
    }

    // 读取历史缓冲日志
    if (req.method === "GET" && urlPath === "/api/logs") {
      sendJson(res, 200, { logs: getLogs() });
      return;
    }

    // 清空缓冲日志
    if (req.method === "POST" && urlPath === "/api/logs/clear") {
      clearLogs();
      sendJson(res, 200, { ok: true });
      return;
    }

    // SSE 实时日志推送流
    if (req.method === "GET" && urlPath === "/api/logs/stream") {
      this._openSseStream(req, res, (send) => {
        return subscribeLogs((entry) => {
          send("log", JSON.stringify(entry));
        });
      });
      return;
    }

    // Milky API 在线调试调用
    if (req.method === "POST" && urlPath === "/api/milky/call") {
      const milky = this.bridge ? this.bridge.milkyAdapter : null;
      if (!milky || typeof milky.invokeAction !== "function") {
        sendJson(res, 503, { ok: false, message: "Milky 适配器尚未就绪" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const action = typeof body.action === "string" ? body.action.trim() : "";
        if (!action) {
          sendJson(res, 400, { ok: false, message: "缺少 API 动作名称" });
          return;
        }
        const params = body.params && typeof body.params === "object" ? body.params : {};
        const token = typeof body.token === "string" ? body.token : "";
        const startedAt = performance.now();
        const result = await milky.invokeAction(action, params, token);
        const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
        sendJson(res, 200, {
          ok: true,
          http_status: result.httpStatus,
          duration_ms: durationMs,
          payload: result.body,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: err.message || "请求解析失败" });
      }
      return;
    }

    // Milky 协议事件实时监听流（SSE）
    if (req.method === "GET" && urlPath === "/api/milky/events") {
      const milky = this.bridge ? this.bridge.milkyAdapter : null;
      if (!milky || typeof milky.subscribeEvents !== "function") {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: "Milky 适配器尚未就绪" }));
        return;
      }
      this._openSseStream(req, res, (send) => {
        return milky.subscribeEvents((payloadStr) => {
          send("milky_event", payloadStr);
        });
      });
      return;
    }

    sendJson(res, 404, { ok: false, message: "未知接口" });
  }

  // 建立通用 SSE 长连接并自动管理心跳与退订
  _openSseStream(req, res, registerFn) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":connected\n\n");

    const sendEvent = (eventName, jsonLine) => {
      try {
        res.write(`event: ${eventName}\ndata: ${jsonLine}\n\n`);
      } catch {
        // 忽略已关闭套接字写入异常
      }
    };

    const unsubscribe = registerFn(sendEvent);
    const keepaliveTimer = setInterval(() => {
      try {
        res.write(":ping\n\n");
      } catch {
        clearInterval(keepaliveTimer);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepaliveTimer);
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    });
  }

  // 汇总当前实例的运行状态
  _collectStatus() {
    const bridge = this.bridge || {};
    const cfg = bridge.config || {};
    const milky = bridge.milkyAdapter || null;
    const translator = milky ? milky.eventTranslator : null;
    const selfInfo = bridge.selfInfo || {};
    const mem = process.memoryUsage();

    let qrAvailable = false;
    let qrMtimeMs = 0;
    try {
      const st = fs.statSync("/tmp/qrcode.png");
      if (st.size > 0) {
        qrAvailable = true;
        qrMtimeMs = Math.floor(st.mtimeMs);
      }
    } catch {
      qrAvailable = false;
    }

    const uinStr = typeof selfInfo.uin === "string"
      ? selfInfo.uin
      : (typeof selfInfo.uin === "number" ? JSON.stringify(selfInfo.uin) : "");

    const milkyPort = typeof cfg.milkyPort === "number" ? cfg.milkyPort : 0;
    const milkyToken = typeof cfg.milkyToken === "string" ? cfg.milkyToken : "";

    return {
      status: "ok",
      version: VERSION,
      server_version: SERVER_VERSION,
      node_version: process.version,
      platform: `${process.platform}/${process.arch}`,
      pid: process.pid,
      uptime_sec: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      memory: {
        rss: mem.rss,
        heap_used: mem.heapUsed,
        heap_total: mem.heapTotal,
      },
      qq: {
        version: (bridge.packageJSON && bridge.packageJSON.version) || "",
        profile_label: bridge.profile ? bridge.profile.label : "",
        resolved_by: bridge.profile ? bridge.profile.resolvedBy : "",
        session_mode: bridge.profile && bridge.profile.session ? bridge.profile.session.mode : "",
      },
      login: {
        logged_in: uinStr !== "",
        uin: uinStr,
        uid: selfInfo.uid || "",
        nickname: selfInfo.nickName || "",
        auto_relogin: cfg.autoRelogin !== false,
        qrcode_available: qrAvailable,
        qrcode_mtime_ms: qrMtimeMs,
      },
      bridge: {
        host: this.host,
        port: this.port,
        ws_clients: this.wsClients ? this.wsClients.size : 0,
      },
      milky: {
        port_enabled: milkyPort > 0,
        host: cfg.milkyHost || "0.0.0.0",
        port: milkyPort,
        token_required: milkyToken !== "",
        ws_clients: milky && milky.wsClients ? milky.wsClients.size : 0,
        sse_clients: milky && milky.sseClients ? milky.sseClients.size : 0,
        webhook_urls: Array.isArray(cfg.milkyWebhookUrls) ? cfg.milkyWebhookUrls.length : 0,
        cached_friends: translator && translator._buddyList ? translator._buddyList.size : 0,
        cached_groups: translator && translator._groupList ? translator._groupList.size : 0,
        seq_counter: translator ? translator._seqCounter : 0,
        events_total: milky && milky.stats ? milky.stats.eventsTotal : 0,
        api_calls_total: milky && milky.stats ? milky.stats.apiCallsTotal : 0,
      },
    };
  }

  _serveQrPng(res) {
    fs.readFile("/tmp/qrcode.png", (err, buf) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("QR code not available yet");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    });
  }

  // --- 底层 Bridge RPC 调度 ---

  async _handleRequest(msg) {
    const echo = msg.data?.echo || randomUUID();
    try {
      if (msg.type === "call") {
        const result = await this.bridge.handleCall(msg.data.func, msg.data.args);
        return { type: "call", data: { result, echo } };
      }
      if (msg.type === "send" || msg.type === "send_pb") {
        const result = await this.bridge.handleSendPB(msg.data.cmd, msg.data.pb);
        return { type: "send", data: { ...result, echo } };
      }
      if (msg.type === "tell_port") {
        return { type: "tell_port", data: { success: true, echo } };
      }
    } catch (e) {
      console.error(`[server] 处理请求 ${msg.type} 出错:`, e.message);
      return { type: msg.type, data: { result: e.message, echo } };
    }
    return { type: "unknown", data: { echo } };
  }
}

/** 将 Map 对象转换为普通键值对象以便 JSON 序列化 */
function mapReplacer(key, value) {
  if (value instanceof Map) {
    const obj = {};
    for (const [k, v] of value) obj[k] = v;
    return obj;
  }
  return value;
}

module.exports = { BridgeServer };
