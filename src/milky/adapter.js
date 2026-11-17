"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { handlers } = require("./actions");
const { MilkyEventTranslator } = require("./events");
const { toIdNum, toIdKey, ensureStr, getMediaDownload } = require("./id");

// 根据图片文件头魔数识别 MIME 类型
function detectMediaMime(buf) {
  if (!buf || buf.length < 4) return "application/octet-stream";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return "image/webp";
  return "application/octet-stream";
}

/**
 * Milky 协议服务端适配器：
 *   - HTTP POST /api/:action  — 动作调用
 *   - HTTP GET  /media/:token — 免请求头鉴权的签名令牌富媒体代理下载
 *   - GET /event              — SSE 事件流
 *   - WebSocket /event        — WebSocket 事件流
 *   - Webhook POST            — 事件推送
 */
class MilkyAdapter {
  constructor(config, bridge) {
    this.config = config;
    this.bridge = bridge;
    this.publicBaseUrl = typeof config.publicUrl === "string" && config.publicUrl.trim() !== ""
      ? config.publicUrl.trim().replace(/\/+$/, "")
      : "";
    const fallbackHost = !config.host || config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host;
    this._lastClientBaseUrl = `http://${fallbackHost}:${config.port}`;

    this.eventTranslator = new MilkyEventTranslator(
      bridge,
      (token) => `${this._getMediaBaseUrl()}/media/${token}`
    );

    this.httpServer = null;
    this.wss = null;
    this.sseClients = new Set();
    this.wsClients = new Set();
    this.eventSubscribers = new Set();
    this._pendingDownloads = new Map();
    this.stats = { eventsTotal: 0, apiCallsTotal: 0 };
    this._memberPreloaded = false;
  }

  _isLoginReady() {
    const uin = this.bridge && this.bridge.selfInfo && this.bridge.selfInfo.uin;
    return toIdNum(uin) > 0;
  }

  _recordClientHost(req) {
    if (this.publicBaseUrl !== "") return;
    const hostHeader = req && req.headers && req.headers.host;
    if (typeof hostHeader === "string" && hostHeader.trim() !== "") {
      this._lastClientBaseUrl = `http://${hostHeader.trim()}`;
    }
  }

  _getMediaBaseUrl() {
    return this.publicBaseUrl !== "" ? this.publicBaseUrl : this._lastClientBaseUrl;
  }

  async start() {
    if (!this.config.port) return;

    this.httpServer = http.createServer((req, res) => this._handleHttp(req, res));

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => {
      ws._boundUin = toIdKey(this.bridge.selfInfo.uin);
      ws._boundNick = ensureStr(this.bridge.selfInfo.nickName, "");
      console.log(`[milky] WebSocket client connected (uin=${ws._boundUin})`);
      this.wsClients.add(ws);
      ws.on("close", () => {
        console.log("[milky] WebSocket client disconnected");
        this.wsClients.delete(ws);
      });
      ws.on("error", (e) => {
        console.error("[milky] WebSocket error:", e.message);
        this.wsClients.delete(ws);
      });
    });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/event") {
        socket.destroy();
        return;
      }
      if (!this._checkAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this._recordClientHost(req);
      if (!this._isLoginReady()) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, this.config.host || "0.0.0.0", () => {
        console.log(`[milky] HTTP/WS/SSE listening on ${this.config.host || "0.0.0.0"}:${this.config.port}`);
        resolve();
      });
      this.httpServer.on("error", reject);
    });
  }

  // ---- HTTP 请求分发 ----

  _handleHttp(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");

    // 能力令牌保护的临时富媒体下载路由，供客户端拉取 NTQQ 图片字节
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const token = url.pathname.slice(7);
      this._handleMediaRequest(res, token);
      return;
    }

    if (!this._checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", retcode: 1403, data: null }));
      return;
    }

    this._recordClientHost(req);

    // SSE 事件流
    if (req.method === "GET" && url.pathname === "/event") {
      if (!this._isLoginReady()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "failed", retcode: 1503, message: "QQ login not ready", data: null }));
        return;
      }
      this._handleSSE(req, res);
      return;
    }

    // API 动作调用
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      this._handleApiCall(req, res, url);
      return;
    }

    // 健康检查
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", impl: "waylay", protocol: "milky" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "failed", retcode: 1404, data: null }));
  }

  async _handleMediaRequest(res, token) {
    const entry = getMediaDownload(token);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Media not found");
      return;
    }
    try {
      const buf = await this._ensureMediaBytes(entry);
      res.writeHead(200, {
        "Content-Type": detectMediaMime(buf),
        "Content-Length": buf.length,
        "Cache-Control": "private, max-age=300",
      });
      res.end(buf);
    } catch (e) {
      console.warn(`[milky] 拉取富媒体失败 (${entry.msgId}/${entry.elementId}):`, e.message);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Media download failed");
    }
  }

  async _ensureMediaBytes(entry) {
    if (entry.filePath) {
      try {
        const existing = await fs.promises.readFile(entry.filePath);
        if (existing.length > 0) return existing;
      } catch {}
    }

    if (!this.bridge || !this.bridge.session) {
      throw new Error("NTQQ session not ready");
    }

    const inflight = this._pendingDownloads.get(entry.key);
    if (inflight) {
      return await inflight.promise;
    }

    let resolveFn = null;
    let rejectFn = null;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timer = setTimeout(() => {
      this._pendingDownloads.delete(entry.key);
      rejectFn(new Error("Rich media download timed out"));
    }, 15000);

    this._pendingDownloads.set(entry.key, {
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      timer,
      msgId: entry.msgId,
      elementId: entry.elementId,
      filePath: entry.filePath,
    });

    try {
      if (entry.filePath) {
        await fs.promises.mkdir(path.dirname(entry.filePath), { recursive: true });
      }
      this.bridge.session.getMsgService().downloadRichMedia({
        fileModelId: "0",
        downloadSourceType: 0,
        triggerType: 1,
        msgId: entry.msgId,
        chatType: entry.chatType,
        peerUid: entry.peerUid,
        elementId: entry.elementId,
        thumbSize: 0,
        downloadType: 1,
        filePath: entry.filePath,
      });
    } catch (e) {
      clearTimeout(timer);
      this._pendingDownloads.delete(entry.key);
      throw e;
    }

    return await promise;
  }

  async _onRichMediaDownloaded(data) {
    if (!data || this._pendingDownloads.size === 0) return;
    const msgId = ensureStr(data.msgId || data.commonFileInfo?.msgId, "");
    const elemId = ensureStr(data.msgElementId || data.commonFileInfo?.elemId, "");
    if (!msgId || !elemId) return;

    for (const [key, pending] of this._pendingDownloads.entries()) {
      if (pending.msgId !== msgId || pending.elementId !== elemId) continue;
      clearTimeout(pending.timer);
      this._pendingDownloads.delete(key);

      const errCode = ensureStr(data.fileErrCode, "0");
      if (errCode !== "0" && errCode !== "") {
        pending.reject(new Error(data.fileErrMsg || `fileErrCode=${errCode}`));
        continue;
      }

      const finalPath = ensureStr(data.filePath, "") || pending.filePath;
      try {
        const buf = await fs.promises.readFile(finalPath);
        if (buf.length === 0) {
          pending.reject(new Error("Downloaded media file is empty"));
        } else {
          pending.resolve(buf);
        }
      } catch (e) {
        pending.reject(e);
      }
    }
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");

    this.sseClients.add(res);
    console.log("[milky] SSE client connected");

    req.on("close", () => {
      this.sseClients.delete(res);
      console.log("[milky] SSE client disconnected");
    });
  }

  async _handleApiCall(req, res, url) {
    const action = url.pathname.replace(/^\/api\//, "");

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let params = {};
    try {
      if (body) params = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", retcode: 1400, data: null }));
      return;
    }

    console.log(`[milky] <- api: ${action}`);
    this.stats.apiCallsTotal++;

    const handler = handlers[action];
    if (!handler) {
      console.warn(`[milky] Unknown action: ${action}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", retcode: 1404, data: null }));
      return;
    }

    try {
      const data = await handler(params, this.bridge, this.eventTranslator);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data }, mapReplacer));
    } catch (e) {
      console.error(`[milky] Action ${action} error:`, e.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", retcode: 1400, message: e.message || "执行失败", data: null }));
    }
  }

  // ---- 鉴权 ----

  _checkAuth(req) {
    if (!this.config.token) return true;
    const auth = req.headers.authorization;
    const url = new URL(req.url, "http://localhost");
    const token = auth?.replace("Bearer ", "") || url.searchParams.get("access_token");
    return token === this.config.token;
  }

  // ---- 事件推送 ----

  pushEvent(listenerName, eventName, data) {
    if (listenerName === "nodeIKernelMsgListener" && eventName === "onRichMediaDownloadComplete") {
      this._onRichMediaDownloaded(data);
    }
    const events = this.eventTranslator.translate(listenerName, eventName, data);
    for (const event of events) {
      this._broadcast(event);
    }
    if (!this._memberPreloaded && listenerName === "nodeIKernelGroupListener" && eventName === "onGroupListUpdate") {
      this._memberPreloaded = true;
      setTimeout(() => this._preloadGroupMembers(), 2000);
    }
  }

  _broadcast(event) {
    this.stats.eventsTotal++;
    const payload = JSON.stringify(event, mapReplacer);

    for (const sub of this.eventSubscribers) {
      try {
        sub(payload);
      } catch {
        this.eventSubscribers.delete(sub);
      }
    }

    for (const res of this.sseClients) {
      try {
        res.write(`event: ${event.event_type}\ndata: ${payload}\n\n`);
      } catch {
        this.sseClients.delete(res);
      }
    }

    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }

    if (this.config.webhookUrls?.length) {
      for (const url of this.config.webhookUrls) {
        this._postWebhook(url, payload);
      }
    }
  }

  _postWebhook(urlStr, payload) {
    try {
      const url = new URL(urlStr);
      const options = {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      if (this.config.token) {
        options.headers.Authorization = `Bearer ${this.config.token}`;
      }
      const proto = url.protocol === "https:" ? require("https") : http;
      const req = proto.request(options);
      req.on("error", (e) => console.warn(`[milky] Webhook error (${urlStr}):`, e.message));
      req.write(payload);
      req.end();
    } catch (e) {
      console.warn(`[milky] Webhook error (${urlStr}):`, e.message);
    }
  }

  notifyLogin() {
    this._memberPreloaded = false;
    const currentUin = toIdKey(this.bridge && this.bridge.selfInfo && this.bridge.selfInfo.uin);
    const currentNick = ensureStr(this.bridge && this.bridge.selfInfo && this.bridge.selfInfo.nickName, "");
    if (!currentUin || currentUin === "0") return;

    for (const ws of this.wsClients) {
      const stale = ws._boundUin !== currentUin || (ws._boundNick === "" && currentNick !== "");
      if (stale) {
        console.log(`[milky] 登录信息已更新 (${currentNick}/${currentUin})，刷新早期 WebSocket 连接`);
        try { ws.close(1012, "Login updated"); } catch {}
      }
    }
  }

  /** 订阅 Milky 协议事件 JSON 字符串流（供控制台实时监控使用） */
  subscribeEvents(listener) {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  /** 供控制台调试面板调用指定的 Milky API 动作 */
  async invokeAction(action, params, providedToken) {
    if (this.config.token && providedToken !== this.config.token) {
      return {
        httpStatus: 401,
        body: { status: "failed", retcode: 1403, message: "鉴权失败：需要正确的 MILKY_TOKEN", data: null },
      };
    }

    this.stats.apiCallsTotal++;
    console.log(`[milky] <- console-debug: ${action}`);

    const handler = handlers[action];
    if (!handler) {
      return {
        httpStatus: 200,
        body: { status: "failed", retcode: 1404, message: `未知的 API 动作: ${action}`, data: null },
      };
    }

    try {
      const safeParams = params && typeof params === "object" ? params : {};
      const data = await handler(safeParams, this.bridge, this.eventTranslator);
      return {
        httpStatus: 200,
        body: { status: "ok", retcode: 0, data },
      };
    } catch (e) {
      console.error(`[milky] 调试动作 ${action} 异常:`, e.message);
      return {
        httpStatus: 200,
        body: { status: "failed", retcode: 1400, message: e.message || "执行失败", data: null },
      };
    }
  }

  async _preloadGroupMembers() {
    if (!this.bridge.session) return;
    try {
      const groups = this.eventTranslator.getGroupList();
      const groupService = this.bridge.session.getGroupService();
      for (const g of groups) {
        try {
          const sceneId = groupService.createMemberListScene(g.groupCode, `milky_preload_${g.groupCode}`);
          await groupService.getNextMemberList(sceneId, undefined, 3000);
          try { groupService.destroyMemberListScene(sceneId); } catch {}
        } catch {}
      }
      console.log(`[milky] Preloaded member lists for ${groups.length} groups`);
    } catch (e) {
      console.warn("[milky] Failed to preload group members:", e.message);
    }
  }
}

function mapReplacer(key, value) {
  if (value instanceof Map) {
    const obj = {};
    for (const [k, v] of value) obj[k] = v;
    return obj;
  }
  return value;
}

module.exports = { MilkyAdapter };
