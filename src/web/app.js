"use strict";

// Waylay WebUI 控制台主逻辑：状态监控、扫码与快速登录、实时日志跟踪、Milky 调试台

(function () {
  const UI = window.WaylayUI;
  const SCHEMA = window.MILKY_API_SCHEMA || [];

  // 全局状态
  const state = {
    activeView: "overview",
    latestStatus: null,
    lastQrMtime: 0,
    qrForceNonce: 0,

    // 日志状态
    logs: [],
    logFilterLevel: "all",
    logFilterTag: "all",
    logKeyword: "",
    logAutoScroll: true,
    logPaused: false,
    logTagsKnown: new Set(["main", "bridge", "server", "milky", "event", "profiles"]),
    logEventSource: null,

    // Milky API 调试状态
    selectedAction: "get_login_info",
    callMode: "proxy",
    lastResponseRaw: "",
    apiHistory: [],

    // Milky 事件监听状态
    milkyEvents: [],
    evFilterType: "all",
    evAutoFollow: true,
    evPaused: false,
    selectedEventId: 0,
    evCounter: 0,
    milkyEventSource: null,
  };

  // 视图元信息
  const VIEW_META = {
    overview: {
      title: "运行状态监控",
      subtitle: "实时查看内核指标、内存负载与协议接入状态",
    },
    login: {
      title: "扫码与快速登录",
      subtitle: "扫描二维码或选用本机历史凭证登录 QQ 内核",
    },
    logs: {
      title: "实时日志跟踪",
      subtitle: "通过 SSE 流实时观测内核事件、桥接通信与适配器日志",
    },
    milky: {
      title: "Milky 调试台",
      subtitle: "在线构造并测试 Milky 协议 API 调用与实时事件流",
    },
  };

  // ==================== 工具函数 ====================

  // 格式化秒数为可读时长
  function formatUptime(sec) {
    if (typeof sec !== "number" || sec < 0) return "--";
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    if (days > 0) {
      return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  }

  // 字节数转 MB 文本（保留 1 位小数）
  function formatMB(bytes) {
    if (typeof bytes !== "number" || bytes <= 0) return "0.0";
    const tenths = Math.round((bytes / (1024 * 1024)) * 10);
    const whole = Math.floor(tenths / 10);
    const frac = tenths % 10;
    return `${whole}.${frac}`;
  }

  // 时间戳转 HH:mm:ss
  function formatClock(ms) {
    const d = new Date(ms);
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // 装配页面静态 data-icon 占位图标
  function hydrateIcons() {
    const nodes = document.querySelectorAll("[data-icon]");
    for (let i = 0; i < nodes.length; i++) {
      const name = nodes[i].getAttribute("data-icon");
      if (UI.ICONS[name]) {
        nodes[i].innerHTML = UI.ICONS[name];
      }
    }
  }

  // ==================== 导航与主题切换 ====================

  function switchView(viewName) {
    if (!VIEW_META[viewName]) return;
    state.activeView = viewName;

    const navBtns = document.querySelectorAll("[data-nav]");
    for (let i = 0; i < navBtns.length; i++) {
      const btn = navBtns[i];
      if (btn.getAttribute("data-nav") === viewName) {
        btn.classList.add("is-active");
      } else {
        btn.classList.remove("is-active");
      }
    }

    const panels = document.querySelectorAll(".view-panel");
    for (let i = 0; i < panels.length; i++) {
      panels[i].classList.remove("is-active");
    }
    const activePanel = document.getElementById(`view-${viewName}`);
    if (activePanel) activePanel.classList.add("is-active");

    document.getElementById("topbar-title").textContent = VIEW_META[viewName].title;
    document.getElementById("topbar-subtitle").textContent = VIEW_META[viewName].subtitle;

    // 移动端收起侧边栏
    document.getElementById("sidebar").classList.remove("is-mobile-open");

    if (viewName === "login") {
      loadLoginCandidates();
    }
    if (viewName === "logs" && state.logAutoScroll) {
      scrollLogsToBottom();
    }
  }

  function initThemeSwitcher() {
    const isDarkInit = document.documentElement.classList.contains("dark");
    const themeTabs = UI.createTabs({
      items: [
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
      ],
      value: isDarkInit ? "dark" : "light",
      onChange(mode) {
        if (mode === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
        try {
          localStorage.setItem("waylay-theme", mode);
        } catch {}
      },
    });
    themeTabs.el.style.width = "100%";
    const triggers = themeTabs.el.querySelectorAll(".sh-tabs-trigger");
    for (let i = 0; i < triggers.length; i++) {
      triggers[i].style.flex = "1";
      triggers[i].style.justifyContent = "center";
    }
    document.getElementById("theme-tabs-mount").appendChild(themeTabs.el);
  }

  // ==================== 1. 状态轮询与监控渲染 ====================

  async function fetchStatus(showFeedback) {
    try {
      const resp = await fetch("/api/status", {
        headers: { Accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      state.latestStatus = data;
      renderStatus(data);
      if (showFeedback) {
        UI.toast({ title: "运行状态已刷新" });
      }
    } catch {
      document.getElementById("conn-dot").classList.remove("is-online");
      document.getElementById("conn-label").textContent = "连接中断";
      if (showFeedback) {
        UI.toast({ title: "状态获取失败", description: "请检查 Waylay 服务是否在线", inverted: true });
      }
    }
  }

  function renderStatus(s) {
    // 侧边栏与顶栏公共指示器
    document.getElementById("conn-dot").classList.add("is-online");
    document.getElementById("conn-label").textContent = "服务在线";
    document.getElementById("brand-version").textContent = `v${s.version || "-"}`;
    document.getElementById("sidebar-uptime").textContent = formatUptime(s.uptime_sec);

    const login = s.login || {};
    const milky = s.milky || {};
    const bridge = s.bridge || {};
    const qq = s.qq || {};
    const mem = s.memory || {};

    const navBadge = document.getElementById("nav-login-badge");
    const topAccount = document.getElementById("topbar-account-pill");
    if (login.logged_in) {
      navBadge.textContent = "已登录";
      navBadge.className = "sh-badge sh-badge--solid";
      topAccount.textContent = login.nickname
        ? `${login.nickname} (${login.uin})`
        : `QQ ${login.uin}`;
      topAccount.className = "sh-badge sh-badge--secondary";
    } else {
      navBadge.textContent = login.qrcode_available ? "待扫码" : "未登录";
      navBadge.className = "sh-badge sh-badge--outline";
      topAccount.textContent = "未登录";
      topAccount.className = "sh-badge sh-badge--outline";
    }

    // KPI 卡片
    document.getElementById("kpi-login-state").textContent = login.logged_in ? "在线" : "未登录";
    document.getElementById("kpi-login-sub").textContent = login.logged_in
      ? `${login.nickname || "QQ"} · ${login.uin}`
      : (login.qrcode_available ? "登录二维码已就绪，请扫码" : "等待登录授权");

    document.getElementById("kpi-milky-traffic").textContent =
      `${milky.events_total || 0} / ${milky.api_calls_total || 0}`;
    document.getElementById("kpi-milky-clients").textContent =
      `事件推送 / API 调用 · ${(milky.ws_clients || 0) + (milky.sse_clients || 0)} 活跃订阅`;

    document.getElementById("kpi-mem-rss").textContent = `${formatMB(mem.rss)} MB`;
    document.getElementById("kpi-cache-counts").textContent =
      `缓存 ${milky.cached_friends || 0} 好友 · ${milky.cached_groups || 0} 群聊`;

    document.getElementById("kpi-uptime").textContent = formatUptime(s.uptime_sec);
    document.getElementById("kpi-platform").textContent =
      `PID ${s.pid || "-"} · ${s.platform || "-"}`;

    // 系统与内核详情卡片
    document.getElementById("ov-qq-ver").textContent = qq.version ? `QQ ${qq.version}` : "QQ 未加载";
    document.getElementById("ov-server-ver").textContent = s.server_version || "-";
    document.getElementById("ov-profile").textContent = qq.profile_label
      ? `${qq.profile_label} (${qq.resolved_by || "-"})`
      : "-";
    document.getElementById("ov-session-mode").textContent = qq.session_mode || "-";
    document.getElementById("ov-auto-relogin").textContent = login.auto_relogin ? "已开启" : "已禁用";
    document.getElementById("ov-node-ver").textContent = s.node_version || "-";
    document.getElementById("ov-seq-counter").textContent = `${milky.seq_counter || 0}`;

    const heapUsedMB = formatMB(mem.heap_used);
    const heapTotalMB = formatMB(mem.heap_total);
    document.getElementById("ov-heap-label").textContent = `${heapUsedMB} / ${heapTotalMB} MB`;
    const pct = mem.heap_total > 0
      ? Math.min(100, Math.round((mem.heap_used / mem.heap_total) * 100))
      : 0;
    document.getElementById("ov-heap-bar").style.width = `${pct}%`;

    // 端点卡片
    const milkyBadge = document.getElementById("ov-milky-badge");
    if (milky.port_enabled) {
      milkyBadge.textContent = `Milky :${milky.port} 运行中`;
      milkyBadge.className = "sh-badge sh-badge--solid";
    } else {
      milkyBadge.textContent = "仅控制台内置模式";
      milkyBadge.className = "sh-badge sh-badge--outline";
    }

    document.getElementById("ov-bridge-ws").textContent = `${bridge.ws_clients || 0}`;
    document.getElementById("ov-milky-conns").textContent =
      `${milky.ws_clients || 0} WS / ${milky.sse_clients || 0} SSE`;
    document.getElementById("ov-milky-webhooks").textContent = `${milky.webhook_urls || 0}`;
    document.getElementById("ov-milky-auth").textContent = milky.token_required ? "已启用 Bearer 鉴权" : "未设密码";

    renderEndpointsList(bridge, milky);
    renderLoginView(login);
  }

  function renderEndpointsList(bridge, milky) {
    const host = window.location.hostname || "127.0.0.1";
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const httpProto = window.location.protocol === "https:" ? "https" : "http";
    const bridgePort = bridge.port || 13000;

    const endpoints = [
      {
        name: "Bridge WebSocket 端点",
        url: `${wsProto}://${host}:${bridgePort}/ws`,
      },
      {
        name: "原始登录二维码图片 (PNG)",
        url: `${httpProto}://${host}:${bridgePort}/qrcode.png`,
      },
    ];

    if (milky.port_enabled && milky.port) {
      endpoints.push(
        {
          name: "Milky HTTP API 基址",
          url: `${httpProto}://${host}:${milky.port}/api/:action`,
        },
        {
          name: "Milky WebSocket 事件流",
          url: `${wsProto}://${host}:${milky.port}/event`,
        },
        {
          name: "Milky SSE 事件流",
          url: `${httpProto}://${host}:${milky.port}/event`,
        }
      );
    }

    const container = document.getElementById("ov-endpoints-list");
    container.innerHTML = "";
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      const row = document.createElement("div");
      row.className = "endpoint-box";

      const meta = document.createElement("div");
      meta.className = "endpoint-meta";
      const nm = document.createElement("div");
      nm.className = "endpoint-name";
      nm.textContent = ep.name;
      const u = document.createElement("div");
      u.className = "endpoint-url";
      u.textContent = ep.url;
      meta.appendChild(nm);
      meta.appendChild(u);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "sh-btn sh-btn--ghost sh-btn--icon";
      copyBtn.title = "复制地址";
      copyBtn.innerHTML = UI.ICONS.copy;
      copyBtn.addEventListener("click", () => {
        UI.copyText(ep.url, `已复制 ${ep.name}`);
      });

      row.appendChild(meta);
      row.appendChild(copyBtn);
      container.appendChild(row);
    }
  }

  // ==================== 2. 扫码与快速登录逻辑 ====================

  let quickAccountSelect = null;

  function renderLoginView(login) {
    const qrBadge = document.getElementById("qr-status-badge");
    const qrImg = document.getElementById("qr-image");
    const qrPlaceholder = document.getElementById("qr-placeholder");
    const qrHint = document.getElementById("qr-hint-text");

    const avatarBox = document.getElementById("login-avatar-box");
    const nickEl = document.getElementById("login-nick");
    const uinEl = document.getElementById("login-uin");
    const onlinePill = document.getElementById("login-online-pill");

    if (login.logged_in) {
      onlinePill.textContent = "在线";
      onlinePill.className = "sh-badge sh-badge--solid";
      nickEl.textContent = login.nickname || `QQ 用户`;
      uinEl.textContent = `UIN: ${login.uin}${login.uid ? ` · UID: ${login.uid}` : ""}`;

      if (avatarBox.getAttribute("data-uin") !== login.uin) {
        avatarBox.setAttribute("data-uin", login.uin);
        avatarBox.innerHTML = "";
        const img = document.createElement("img");
        img.src = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(login.uin)}&s=100`;
        img.alt = "头像";
        img.addEventListener("error", () => {
          avatarBox.textContent = "QQ";
        });
        avatarBox.appendChild(img);
      }

      qrBadge.textContent = "已登录";
      qrBadge.className = "sh-badge sh-badge--solid";
      qrImg.style.display = "none";
      qrPlaceholder.style.display = "block";
      qrPlaceholder.textContent = `已登录账号 ${login.uin}，无需扫码`;
      qrHint.textContent = "如需切换账号或重新获取二维码，可点击下方按钮主动请求";
      return;
    }

    // 未登录态
    avatarBox.removeAttribute("data-uin");
    avatarBox.textContent = "?";
    onlinePill.textContent = "离线";
    onlinePill.className = "sh-badge sh-badge--outline";
    nickEl.textContent = "尚未登录";
    uinEl.textContent = "请通过左侧扫码或下方历史凭证快速登录";

    if (login.qrcode_available) {
      qrBadge.textContent = "等待扫码";
      qrBadge.className = "sh-badge sh-badge--secondary";
      qrHint.textContent = "请打开手机 QQ 扫一扫确认登录";
      if (state.lastQrMtime !== login.qrcode_mtime_ms) {
        state.lastQrMtime = login.qrcode_mtime_ms;
        qrImg.src = `/qrcode.png?t=${login.qrcode_mtime_ms}_${state.qrForceNonce}`;
      }
      qrPlaceholder.style.display = "none";
      qrImg.style.display = "block";
    } else {
      qrBadge.textContent = "无二维码";
      qrBadge.className = "sh-badge sh-badge--outline";
      qrImg.style.display = "none";
      qrPlaceholder.style.display = "block";
      qrPlaceholder.textContent = "当前暂无可用的二维码图片，请点击下方按钮请求生成";
      qrHint.textContent = "点击「生成 / 刷新二维码」向 QQ 内核申请新的登录二维码";
    }
  }

  async function requestNewQr() {
    const btn = document.getElementById("btn-refresh-qr");
    btn.disabled = true;
    try {
      const resp = await fetch("/api/login/refresh-qr", { method: "POST" });
      const data = await resp.json();
      if (data && data.ok) {
        state.qrForceNonce++;
        state.lastQrMtime = 0;
        UI.toast({ title: "已向内核请求新二维码", description: "将在 1~2 秒内自动更新显示" });
        setTimeout(() => fetchStatus(false), 1200);
      } else {
        UI.toast({ title: "刷新二维码失败", description: "登录服务尚未准备就绪", inverted: true });
      }
    } catch {
      UI.toast({ title: "网络请求异常", inverted: true });
    } finally {
      btn.disabled = false;
    }
  }

  async function loadLoginCandidates(showToastFeedback) {
    try {
      const resp = await fetch("/api/login/accounts");
      const data = await resp.json();
      const list = Array.isArray(data.accounts) ? data.accounts : [];
      const opts = list.map((acc) => ({
        value: acc.uin,
        label: acc.nick ? `${acc.nick} (${acc.uin})` : acc.uin,
        sub: "历史记录",
      }));
      quickAccountSelect.setOptions(opts);
      if (opts.length > 0 && !document.getElementById("quick-login-input").value) {
        quickAccountSelect.setValue(opts[0].value, true);
        document.getElementById("quick-login-input").value = opts[0].value;
      }
      if (showToastFeedback) {
        UI.toast({
          title: opts.length > 0 ? `已读取 ${opts.length} 个历史账号` : "未发现本机历史登录记录",
        });
      }
    } catch {
      if (showToastFeedback) {
        UI.toast({ title: "读取历史账号失败", inverted: true });
      }
    }
  }

  async function triggerQuickLogin() {
    const input = document.getElementById("quick-login-input");
    const uin = input.value.trim();
    if (!uin) {
      UI.toast({ title: "请输入要快速登录的 QQ 号", inverted: true });
      input.focus();
      return;
    }
    const btn = document.getElementById("btn-trigger-quick-login");
    btn.disabled = true;
    try {
      const resp = await fetch("/api/login/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uin }),
      });
      const data = await resp.json();
      if (data && data.ok) {
        UI.toast({
          title: `已触发账号 ${uin} 快速登录`,
          description: "若凭证有效将自动上线，否则将回退至二维码",
        });
        setTimeout(() => fetchStatus(false), 2000);
      } else {
        UI.toast({ title: "快速登录请求未成功", description: (data && data.message) || "", inverted: true });
      }
    } catch {
      UI.toast({ title: "请求发送失败", inverted: true });
    } finally {
      btn.disabled = false;
    }
  }

  function initLoginModule() {
    quickAccountSelect = UI.createSelect({
      options: [],
      placeholder: "暂无检测到的历史登录记录",
      fullWidth: true,
      onChange(val) {
        if (val) {
          document.getElementById("quick-login-input").value = val;
        }
      },
    });
    document.getElementById("quick-login-select-mount").appendChild(quickAccountSelect.el);

    document.getElementById("btn-refresh-qr").addEventListener("click", requestNewQr);
    document.getElementById("btn-copy-qr-url").addEventListener("click", () => {
      UI.copyText(`${window.location.origin}/qrcode.png`, "已复制二维码图片地址");
    });
    document.getElementById("btn-reload-accounts").addEventListener("click", () => {
      loadLoginCandidates(true);
    });
    document.getElementById("btn-trigger-quick-login").addEventListener("click", triggerQuickLogin);
    document.getElementById("quick-login-input").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") triggerQuickLogin();
    });
  }

  // ==================== 3. 实时日志跟踪模块 ====================

  let logTagSelect = null;

  function matchesLogFilter(entry) {
    if (state.logFilterLevel !== "all" && entry.level !== state.logFilterLevel) {
      return false;
    }
    if (state.logFilterTag !== "all" && entry.tag !== state.logFilterTag) {
      return false;
    }
    if (state.logKeyword) {
      const kw = state.logKeyword.toLowerCase();
      const hitText = (entry.raw || "").toLowerCase().includes(kw);
      const hitTag = (entry.tag || "").toLowerCase().includes(kw);
      if (!hitText && !hitTag) return false;
    }
    return true;
  }

  function createLogRowNode(entry) {
    const row = document.createElement("div");
    row.className = "log-row";

    const timeSpan = document.createElement("span");
    timeSpan.className = "log-time";
    timeSpan.textContent = formatClock(entry.ts);

    const lvlSpan = document.createElement("span");
    lvlSpan.className = entry.level === "error"
      ? "log-lvl log-lvl--error"
      : (entry.level === "warn" ? "log-lvl log-lvl--warn" : "log-lvl");
    lvlSpan.textContent = entry.level;

    const tagSpan = document.createElement("span");
    tagSpan.className = "log-tag";
    tagSpan.textContent = `[${entry.tag}]`;

    const msgSpan = document.createElement("span");
    msgSpan.className = "log-msg";
    msgSpan.textContent = entry.text;

    row.appendChild(timeSpan);
    row.appendChild(lvlSpan);
    row.appendChild(tagSpan);
    row.appendChild(msgSpan);
    return row;
  }

  function renderAllLogs() {
    const viewport = document.getElementById("logs-viewport");
    viewport.innerHTML = "";

    const matched = state.logs.filter(matchesLogFilter);
    document.getElementById("log-count-badge").textContent = `${matched.length} 条`;

    if (matched.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "当前筛选条件下暂无日志";
      viewport.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < matched.length; i++) {
      frag.appendChild(createLogRowNode(matched[i]));
    }
    viewport.appendChild(frag);
    if (state.logAutoScroll) {
      scrollLogsToBottom();
    }
  }

  function scrollLogsToBottom() {
    const viewport = document.getElementById("logs-viewport");
    viewport.scrollTop = viewport.scrollHeight;
  }

  function syncTagSelectOptions() {
    const opts = [{ value: "all", label: "全部模块" }];
    for (const tag of state.logTagsKnown) {
      opts.push({ value: tag, label: `[${tag}]` });
    }
    logTagSelect.setOptions(opts);
  }

  async function loadInitialLogs() {
    try {
      const resp = await fetch("/api/logs");
      const data = await resp.json();
      if (Array.isArray(data.logs)) {
        state.logs = data.logs;
        let addedNewTag = false;
        for (let i = 0; i < state.logs.length; i++) {
          const t = state.logs[i].tag;
          if (t && !state.logTagsKnown.has(t)) {
            state.logTagsKnown.add(t);
            addedNewTag = true;
          }
        }
        if (addedNewTag) syncTagSelectOptions();
        renderAllLogs();
      }
    } catch {}
  }

  function connectLogStream() {
    if (state.logEventSource) {
      state.logEventSource.close();
    }
    const badge = document.getElementById("log-stream-badge");
    const es = new EventSource("/api/logs/stream");
    state.logEventSource = es;

    es.onopen = () => {
      if (!state.logPaused) {
        badge.textContent = "SSE 实时跟踪中";
        badge.className = "sh-badge sh-badge--solid";
      }
    };

    es.addEventListener("log", (ev) => {
      if (state.logPaused) return;
      try {
        const entry = JSON.parse(ev.data);
        state.logs.push(entry);
        if (state.logs.length > 800) {
          state.logs.shift();
        }
        if (entry.tag && !state.logTagsKnown.has(entry.tag)) {
          state.logTagsKnown.add(entry.tag);
          syncTagSelectOptions();
        }
        if (matchesLogFilter(entry)) {
          const viewport = document.getElementById("logs-viewport");
          const empty = viewport.querySelector(".empty-state");
          if (empty) viewport.innerHTML = "";
          viewport.appendChild(createLogRowNode(entry));
          while (viewport.childElementCount > 800) {
            viewport.removeChild(viewport.firstElementChild);
          }
          const matchedCount = state.logs.filter(matchesLogFilter).length;
          document.getElementById("log-count-badge").textContent = `${matchedCount} 条`;
          if (state.logAutoScroll && state.activeView === "logs") {
            scrollLogsToBottom();
          }
        }
      } catch {}
    });

    es.onerror = () => {
      badge.textContent = "重连中...";
      badge.className = "sh-badge sh-badge--outline";
    };
  }

  function initLogsModule() {
    const levelSelect = UI.createSelect({
      value: "all",
      options: [
        { value: "all", label: "全部级别" },
        { value: "info", label: "INFO 信息" },
        { value: "warn", label: "WARN 警告" },
        { value: "error", label: "ERROR 错误" },
      ],
      onChange(val) {
        state.logFilterLevel = val;
        renderAllLogs();
      },
    });
    document.getElementById("log-level-select-mount").appendChild(levelSelect.el);

    logTagSelect = UI.createSelect({
      value: "all",
      options: [{ value: "all", label: "全部模块" }],
      onChange(val) {
        state.logFilterTag = val;
        renderAllLogs();
      },
    });
    syncTagSelectOptions();
    document.getElementById("log-tag-select-mount").appendChild(logTagSelect.el);

    const autoScrollSwitch = UI.createSwitch({
      checked: true,
      label: "自动滚动",
      onChange(checked) {
        state.logAutoScroll = checked;
        if (checked) scrollLogsToBottom();
      },
    });
    document.getElementById("log-autoscroll-mount").appendChild(autoScrollSwitch.el);

    document.getElementById("log-search-input").addEventListener("input", (ev) => {
      state.logKeyword = ev.target.value.trim();
      renderAllLogs();
    });

    const pauseBtn = document.getElementById("btn-toggle-log-pause");
    pauseBtn.addEventListener("click", () => {
      state.logPaused = !state.logPaused;
      const badge = document.getElementById("log-stream-badge");
      if (state.logPaused) {
        pauseBtn.innerHTML = `${UI.ICONS.play}<span>继续</span>`;
        badge.textContent = "已暂停";
        badge.className = "sh-badge sh-badge--secondary";
      } else {
        pauseBtn.innerHTML = `${UI.ICONS.pause}<span>暂停</span>`;
        badge.textContent = "SSE 实时跟踪中";
        badge.className = "sh-badge sh-badge--solid";
        loadInitialLogs();
      }
    });

    document.getElementById("btn-copy-logs").addEventListener("click", () => {
      const lines = state.logs
        .filter(matchesLogFilter)
        .map((e) => `${formatClock(e.ts)} [${e.level.toUpperCase()}] [${e.tag}] ${e.text}`)
        .join("\n");
      if (!lines) {
        UI.toast({ title: "当前没有可复制的日志" });
        return;
      }
      UI.copyText(lines, "已复制筛选后的日志内容");
    });

    document.getElementById("btn-clear-logs").addEventListener("click", () => {
      UI.confirmDialog({
        title: "清空服务端日志缓冲区？",
        description: "该操作会清除当前内存中的历史日志记录，后续新产生的日志仍会继续实时显示。",
        confirmText: "确认清空",
        onConfirm: async () => {
          try {
            await fetch("/api/logs/clear", { method: "POST" });
            state.logs = [];
            renderAllLogs();
            UI.toast({ title: "日志已清空" });
          } catch {
            UI.toast({ title: "清空失败", inverted: true });
          }
        },
      });
    });

    loadInitialLogs();
    connectLogStream();
  }

  // ==================== 4. Milky API 调试台与实时事件监听 ====================

  function renderApiCatalog(keyword) {
    const listEl = document.getElementById("api-catalog-list");
    listEl.innerHTML = "";
    const kw = (keyword || "").trim().toLowerCase();

    const filtered = SCHEMA.filter((item) => {
      if (!kw) return true;
      return (
        item.action.toLowerCase().includes(kw) ||
        item.title.toLowerCase().includes(kw) ||
        item.group.toLowerCase().includes(kw)
      );
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sh-select-empty";
      empty.textContent = "未找到匹配的 API，您仍可在右侧手动输入任意 Action 名称调用";
      listEl.appendChild(empty);
      return;
    }

    let currentGroup = "";
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        const g = document.createElement("div");
        g.className = "api-group-heading";
        g.textContent = currentGroup;
        listEl.appendChild(g);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.action === state.selectedAction
        ? "api-item-btn is-active"
        : "api-item-btn";

      const nameDiv = document.createElement("div");
      nameDiv.className = "api-item-name";
      nameDiv.textContent = item.action;

      const titleDiv = document.createElement("div");
      titleDiv.className = "api-item-title";
      titleDiv.textContent = item.title;

      btn.appendChild(nameDiv);
      btn.appendChild(titleDiv);
      btn.addEventListener("click", () => {
        selectApiItem(item);
      });
      listEl.appendChild(btn);
    }
  }

  function selectApiItem(item) {
    state.selectedAction = item.action;
    document.getElementById("api-action-input").value = item.action;
    document.getElementById("api-action-desc").textContent = item.desc;
    document.getElementById("api-params-editor").value = JSON.stringify(item.template || {}, null, 2);
    renderApiCatalog(document.getElementById("api-search-input").value);
  }

  async function executeMilkyCall() {
    const action = document.getElementById("api-action-input").value.trim();
    if (!action) {
      UI.toast({ title: "请填写 API 动作名称", inverted: true });
      return;
    }

    const rawParams = document.getElementById("api-params-editor").value.trim();
    let parsedParams = {};
    if (rawParams) {
      try {
        parsedParams = JSON.parse(rawParams);
      } catch (err) {
        UI.toast({ title: "JSON 参数格式有误", description: err.message, inverted: true });
        return;
      }
    }

    const token = document.getElementById("api-token-input").value.trim();
    try {
      sessionStorage.setItem("waylay-debug-token", token);
    } catch {}

    const sendBtn = document.getElementById("btn-send-api");
    sendBtn.disabled = true;

    const httpBadge = document.getElementById("res-http-badge");
    const timeBadge = document.getElementById("res-time-badge");
    const viewer = document.getElementById("res-json-viewer");
    httpBadge.textContent = "请求中...";

    try {
      let httpStatus = 200;
      let durationMs = 0;
      let responseBody = null;

      if (state.callMode === "direct") {
        const milkyCfg = state.latestStatus && state.latestStatus.milky;
        if (!milkyCfg || !milkyCfg.port_enabled || !milkyCfg.port) {
          UI.toast({
            title: "未启用 Milky 独立 HTTP 端口",
            description: "请切换为「内置通道」或配置 MILKY_HTTP_PORT",
            inverted: true,
          });
          httpBadge.textContent = "未发送";
          sendBtn.disabled = false;
          return;
        }
        const url = `${window.location.protocol}//${window.location.hostname}:${milkyCfg.port}/api/${encodeURIComponent(action)}`;
        const headers = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const t0 = performance.now();
        const r = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(parsedParams),
        });
        durationMs = Math.round((performance.now() - t0) * 100) / 100;
        httpStatus = r.status;
        responseBody = await r.json();
      } else {
        const r = await fetch("/api/milky/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, params: parsedParams, token }),
        });
        const wrapper = await r.json();
        httpStatus = wrapper.http_status || r.status;
        durationMs = wrapper.duration_ms || 0;
        responseBody = wrapper.payload !== undefined ? wrapper.payload : wrapper;
      }

      const pretty = JSON.stringify(responseBody, null, 2);
      state.lastResponseRaw = pretty;
      viewer.innerHTML = UI.highlightJson(pretty);

      const isOk = httpStatus === 200 && responseBody && responseBody.status === "ok";
      httpBadge.textContent = `HTTP ${httpStatus} · retcode ${responseBody && responseBody.retcode !== undefined ? responseBody.retcode : "-"}`;
      httpBadge.className = isOk
        ? "sh-badge sh-badge--solid sh-badge--mono"
        : "sh-badge sh-badge--outline sh-badge--mono";
      timeBadge.textContent = `${durationMs} ms`;

      state.apiHistory.unshift({
        time: formatClock(Date.now()),
        action,
        paramsText: JSON.stringify(parsedParams, null, 2),
        responseText: pretty,
        httpStatus,
        durationMs,
        ok: isOk,
      });
      if (state.apiHistory.length > 15) state.apiHistory.pop();
      renderApiHistory();
    } catch (err) {
      const errObj = { error: err.message || "网络请求失败" };
      const prettyErr = JSON.stringify(errObj, null, 2);
      state.lastResponseRaw = prettyErr;
      viewer.innerHTML = UI.highlightJson(prettyErr);
      httpBadge.textContent = "请求异常";
      httpBadge.className = "sh-badge sh-badge--outline sh-badge--mono";
    } finally {
      sendBtn.disabled = false;
    }
  }

  function renderApiHistory() {
    const container = document.getElementById("api-history-list");
    container.innerHTML = "";
    if (state.apiHistory.length === 0) {
      const empty = document.createElement("div");
      empty.style.fontSize = "12px";
      empty.style.color = "var(--muted-foreground)";
      empty.style.padding = "4px 0";
      empty.textContent = "暂无调用记录";
      container.appendChild(empty);
      return;
    }

    for (let i = 0; i < state.apiHistory.length; i++) {
      const h = state.apiHistory[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-row";

      const left = document.createElement("span");
      left.textContent = `${h.time}  ${h.action}`;

      const right = document.createElement("span");
      right.style.color = "var(--muted-foreground)";
      right.textContent = `${h.ok ? "OK" : "ERR"} · ${h.durationMs}ms`;

      btn.appendChild(left);
      btn.appendChild(right);
      btn.addEventListener("click", () => {
        state.selectedAction = h.action;
        document.getElementById("api-action-input").value = h.action;
        document.getElementById("api-params-editor").value = h.paramsText;
        state.lastResponseRaw = h.responseText;
        document.getElementById("res-json-viewer").innerHTML = UI.highlightJson(h.responseText);
        document.getElementById("res-http-badge").textContent = `HTTP ${h.httpStatus} (历史回放)`;
        document.getElementById("res-time-badge").textContent = `${h.durationMs} ms`;
        renderApiCatalog(document.getElementById("api-search-input").value);
      });
      container.appendChild(btn);
    }
  }

  function buildCurlCommand() {
    const action = document.getElementById("api-action-input").value.trim() || "get_login_info";
    const rawParams = document.getElementById("api-params-editor").value.trim() || "{}";
    let compactJson = "{}";
    try {
      compactJson = JSON.stringify(JSON.parse(rawParams));
    } catch {
      compactJson = rawParams;
    }
    const token = document.getElementById("api-token-input").value.trim();
    const milkyCfg = state.latestStatus && state.latestStatus.milky;
    const port = (milkyCfg && milkyCfg.port) || 8082;
    const host = window.location.hostname || "127.0.0.1";
    const escapedBody = compactJson.replace(/'/g, "'\\''");
    const authPart = token ? ` \\\n  -H 'Authorization: Bearer ${token}'` : "";
    return `curl -X POST 'http://${host}:${port}/api/${action}' \\\n  -H 'Content-Type: application/json'${authPart} \\\n  -d '${escapedBody}'`;
  }

  // ---- Milky 实时事件流监控 ----

  function connectMilkyEventStream() {
    if (state.milkyEventSource) {
      state.milkyEventSource.close();
    }
    const badge = document.getElementById("milky-ev-stream-badge");
    const es = new EventSource("/api/milky/events");
    state.milkyEventSource = es;

    es.onopen = () => {
      if (!state.evPaused) {
        badge.textContent = "监听中";
        badge.className = "sh-badge sh-badge--solid";
      }
    };

    es.addEventListener("milky_event", (ev) => {
      if (state.evPaused) return;
      try {
        const parsed = JSON.parse(ev.data);
        const id = ++state.evCounter;
        const item = {
          id,
          ts: Date.now(),
          eventType: parsed.event_type || "unknown",
          rawPretty: JSON.stringify(parsed, null, 2),
          summary: summarizeMilkyEvent(parsed),
        };
        state.milkyEvents.unshift(item);
        if (state.milkyEvents.length > 200) {
          state.milkyEvents.pop();
        }
        if (state.evAutoFollow) {
          state.selectedEventId = id;
          showEventDetail(item);
        }
        renderMilkyEventsList();
      } catch {}
    });

    es.onerror = () => {
      badge.textContent = "重连中";
      badge.className = "sh-badge sh-badge--outline";
    };
  }

  function summarizeMilkyEvent(ev) {
    const d = ev.data || {};
    if (ev.event_type === "message_receive") {
      const sender =
        (d.group_member && (d.group_member.card || d.group_member.nickname)) ||
        (d.friend && d.friend.nickname) ||
        d.sender_id ||
        "";
      const scene = d.message_scene || "";
      return `${scene}:${d.peer_id || ""} · ${sender}`;
    }
    if (d.group_id && (d.user_id || d.sender_id || d.initiator_id)) {
      return `群 ${d.group_id} · 用户 ${d.user_id || d.sender_id || d.initiator_id}`;
    }
    if (d.user_id || d.initiator_id) {
      return `用户 ${d.user_id || d.initiator_id}`;
    }
    return `self_id: ${ev.self_id || "-"}`;
  }

  function showEventDetail(item) {
    document.getElementById("ev-detail-title").textContent =
      `事件载荷 · ${item.eventType} (#${item.id})`;
    document.getElementById("ev-detail-viewer").innerHTML = UI.highlightJson(item.rawPretty);
  }

  function renderMilkyEventsList() {
    const container = document.getElementById("milky-events-list");
    container.innerHTML = "";
    const filtered = state.milkyEvents.filter((e) => {
      return state.evFilterType === "all" || e.eventType === state.evFilterType;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "等待匹配的 Milky 协议事件到达...";
      container.appendChild(empty);
      return;
    }

    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = item.id === state.selectedEventId ? "event-item is-active" : "event-item";

      const top = document.createElement("div");
      top.style.display = "flex";
      top.style.justifyContent = "space-between";
      top.style.width = "100%";
      top.style.fontFamily = "var(--font-mono)";
      top.style.fontSize = "12px";

      const typeSpan = document.createElement("span");
      typeSpan.style.fontWeight = "600";
      typeSpan.textContent = item.eventType;

      const timeSpan = document.createElement("span");
      timeSpan.style.color = "var(--muted-foreground)";
      timeSpan.textContent = formatClock(item.ts);

      top.appendChild(typeSpan);
      top.appendChild(timeSpan);

      const sub = document.createElement("div");
      sub.style.fontSize = "11.5px";
      sub.style.color = "var(--muted-foreground)";
      sub.textContent = item.summary;

      btn.appendChild(top);
      btn.appendChild(sub);
      btn.addEventListener("click", () => {
        state.selectedEventId = item.id;
        showEventDetail(item);
        renderMilkyEventsList();
      });
      container.appendChild(btn);
    }
  }

  function initMilkyModule() {
    // 顶部子标签（API 调试 / 事件监听）
    const subTabs = UI.createTabs({
      value: "api",
      items: [
        { value: "api", label: "API 在线调试" },
        { value: "events", label: "协议事件实时监听" },
      ],
      onChange(tab) {
        document.getElementById("milky-pane-api").style.display = tab === "api" ? "" : "none";
        document.getElementById("milky-pane-events").style.display = tab === "events" ? "" : "none";
      },
    });
    document.getElementById("milky-subtabs-mount").appendChild(subTabs.el);

    // 调用通道自定义下拉选择
    const modeSelect = UI.createSelect({
      value: "proxy",
      fullWidth: true,
      options: [
        { value: "proxy", label: "内置桥接通道 (推荐)" },
        { value: "direct", label: "浏览器直连 Milky HTTP" },
      ],
      onChange(val) {
        state.callMode = val;
      },
    });
    document.getElementById("api-mode-select-mount").appendChild(modeSelect.el);

    // 恢复已填过的调试 Token
    try {
      const savedToken = sessionStorage.getItem("waylay-debug-token");
      if (savedToken) {
        document.getElementById("api-token-input").value = savedToken;
      }
    } catch {}

    // Token 明文/密文切换
    const tokenInput = document.getElementById("api-token-input");
    const toggleTokenBtn = document.getElementById("btn-toggle-token");
    toggleTokenBtn.addEventListener("click", () => {
      const hidden = tokenInput.type === "password";
      tokenInput.type = hidden ? "text" : "password";
      toggleTokenBtn.innerHTML = hidden ? UI.ICONS.eyeOff : UI.ICONS.eye;
    });

    // API 目录与搜索
    renderApiCatalog("");
    document.getElementById("api-search-input").addEventListener("input", (ev) => {
      renderApiCatalog(ev.target.value);
    });

    // JSON 编辑器支持 Tab 缩进与 Ctrl/Cmd + Enter 快捷发送
    const editor = document.getElementById("api-params-editor");
    editor.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        executeMilkyCall();
        return;
      }
      if (ev.key === "Tab") {
        ev.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + "  " + editor.value.substring(end);
        editor.selectionStart = start + 2;
        editor.selectionEnd = start + 2;
      }
    });

    document.getElementById("btn-format-json").addEventListener("click", () => {
      try {
        const obj = JSON.parse(editor.value || "{}");
        editor.value = JSON.stringify(obj, null, 2);
      } catch (err) {
        UI.toast({ title: "JSON 语法错误，无法格式化", description: err.message, inverted: true });
      }
    });

    document.getElementById("btn-reset-template").addEventListener("click", () => {
      const currentAct = document.getElementById("api-action-input").value.trim();
      const schemaItem = SCHEMA.find((x) => x.action === currentAct);
      editor.value = JSON.stringify((schemaItem && schemaItem.template) || {}, null, 2);
      UI.toast({ title: "已恢复默认参数模板" });
    });

    document.getElementById("btn-copy-curl").addEventListener("click", () => {
      UI.copyText(buildCurlCommand(), "已复制等价 cURL 命令");
    });

    document.getElementById("btn-send-api").addEventListener("click", executeMilkyCall);

    document.getElementById("btn-copy-res").addEventListener("click", () => {
      if (!state.lastResponseRaw) {
        UI.toast({ title: "暂无可复制的响应结果" });
        return;
      }
      UI.copyText(state.lastResponseRaw, "已复制 JSON 响应");
    });

    document.getElementById("btn-clear-history").addEventListener("click", () => {
      state.apiHistory = [];
      renderApiHistory();
    });

    // 事件筛选与控制
    const evTypeSelect = UI.createSelect({
      value: "all",
      fullWidth: true,
      options: [
        { value: "all", label: "全部事件类型" },
        { value: "message_receive", label: "message_receive (收到消息)" },
        { value: "message_recall", label: "message_recall (消息撤回)" },
        { value: "friend_nudge", label: "friend_nudge (好友戳一戳)" },
        { value: "group_nudge", label: "group_nudge (群戳一戳)" },
        { value: "friend_request", label: "friend_request (好友请求)" },
        { value: "group_join_request", label: "group_join_request (加群请求)" },
        { value: "group_member_increase", label: "group_member_increase (入群)" },
        { value: "group_member_decrease", label: "group_member_decrease (退群)" },
        { value: "group_mute", label: "group_mute (群禁言)" },
      ],
      onChange(val) {
        state.evFilterType = val;
        renderMilkyEventsList();
      },
    });
    document.getElementById("ev-type-select-mount").appendChild(evTypeSelect.el);

    const evFollowSwitch = UI.createSwitch({
      checked: true,
      label: "自动跟随",
      onChange(checked) {
        state.evAutoFollow = checked;
      },
    });
    document.getElementById("ev-autofollow-mount").appendChild(evFollowSwitch.el);

    const pauseEvBtn = document.getElementById("btn-pause-events");
    pauseEvBtn.addEventListener("click", () => {
      state.evPaused = !state.evPaused;
      pauseEvBtn.textContent = state.evPaused ? "继续" : "暂停";
      const b = document.getElementById("milky-ev-stream-badge");
      b.textContent = state.evPaused ? "已暂停" : "监听中";
      b.className = state.evPaused ? "sh-badge sh-badge--secondary" : "sh-badge sh-badge--solid";
    });

    document.getElementById("btn-clear-events").addEventListener("click", () => {
      state.milkyEvents = [];
      state.selectedEventId = 0;
      document.getElementById("ev-detail-viewer").textContent =
        "// 在左侧点击任意捕获到的 Milky 事件以查看完整数据结构";
      renderMilkyEventsList();
    });

    document.getElementById("btn-copy-event-json").addEventListener("click", () => {
      const current = state.milkyEvents.find((x) => x.id === state.selectedEventId);
      if (!current) {
        UI.toast({ title: "请先选择一个事件" });
        return;
      }
      UI.copyText(current.rawPretty, "已复制事件 JSON");
    });

    connectMilkyEventStream();
  }

  // ==================== 启动入口 ====================

  function bootstrap() {
    hydrateIcons();
    initThemeSwitcher();
    initLoginModule();
    initLogsModule();
    initMilkyModule();

    // 绑定侧边栏导航按钮
    const navBtns = document.querySelectorAll("[data-nav]");
    for (let i = 0; i < navBtns.length; i++) {
      navBtns[i].addEventListener("click", () => {
        switchView(navBtns[i].getAttribute("data-nav"));
      });
    }

    // 移动端抽屉开关
    document.getElementById("mobile-menu-btn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("is-mobile-open");
    });

    // 顶栏手动刷新按钮
    document.getElementById("btn-manual-refresh").addEventListener("click", () => {
      fetchStatus(true);
    });

    // 若通过 /qrcode 或 ?view=xxx 访问，自动定位至对应面板
    const pathName = window.location.pathname;
    const qsView = new URLSearchParams(window.location.search).get("view");
    if (pathName === "/qrcode" || pathName === "/qr" || qsView === "login") {
      switchView("login");
    } else if (qsView && VIEW_META[qsView]) {
      switchView(qsView);
    }

    // 首次拉取状态并启动定时同步
    fetchStatus(false);
    setInterval(() => fetchStatus(false), 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
