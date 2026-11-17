"use strict";

// Waylay WebUI — 自定义 shadcn 风格交互组件库（零浏览器原生表单控件）

(function () {
  // 线性极简图标集（Lucide 风格 16x16）
  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    qrcode: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3h-3"/><path d="M14 20h3"/><path d="M20 20h.01"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    braces: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>',
  };

  // 管理所有已打开的下拉浮层，点击外部或按 Esc 统一关闭
  const openPopovers = new Set();

  document.addEventListener("mousedown", (ev) => {
    for (const inst of openPopovers) {
      if (!inst.root.contains(ev.target)) {
        inst.close();
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      for (const inst of openPopovers) {
        inst.close();
      }
    }
  });

  // HTML 安全转义
  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 创建自定义 shadcn Switch 开关组件
  function createSwitch(opts) {
    let state = opts && opts.checked === true;
    const labelText = (opts && opts.label) || "";
    const onChange = opts && opts.onChange;

    const wrapper = document.createElement("div");
    wrapper.className = "sh-switch-field";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sh-switch";
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", state ? "true" : "false");

    const thumb = document.createElement("span");
    thumb.className = "sh-switch-thumb";
    btn.appendChild(thumb);
    wrapper.appendChild(btn);

    if (labelText) {
      const lbl = document.createElement("span");
      lbl.className = "sh-switch-label";
      lbl.textContent = labelText;
      wrapper.appendChild(lbl);
    }

    function setChecked(next, silent) {
      state = next === true;
      btn.setAttribute("aria-checked", state ? "true" : "false");
      if (!silent && typeof onChange === "function") {
        onChange(state);
      }
    }

    wrapper.addEventListener("click", () => {
      setChecked(!state, false);
    });

    return {
      el: wrapper,
      getChecked: () => state,
      setChecked,
    };
  }

  // 创建自定义 shadcn Select / Combobox 下拉选择器（替代原生 <select>）
  function createSelect(opts) {
    let options = Array.isArray(opts.options) ? opts.options.slice() : [];
    let currentValue = typeof opts.value === "string" ? opts.value : "";
    const placeholder = opts.placeholder || "请选择...";
    const searchable = opts.searchable === true;
    const searchPlaceholder = opts.searchPlaceholder || "筛选选项...";
    const fullWidth = opts.fullWidth === true;
    const onChange = opts.onChange;

    const root = document.createElement("div");
    root.className = fullWidth ? "sh-select sh-select--full" : "sh-select";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "sh-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const valueSpan = document.createElement("span");
    valueSpan.className = "sh-select-value";

    const chevronSpan = document.createElement("span");
    chevronSpan.className = "sh-select-chevron";
    chevronSpan.innerHTML = ICONS.chevronDown;

    trigger.appendChild(valueSpan);
    trigger.appendChild(chevronSpan);

    const popover = document.createElement("div");
    popover.className = "sh-select-popover";
    popover.setAttribute("role", "listbox");

    let searchInput = null;
    if (searchable) {
      const searchBox = document.createElement("div");
      searchBox.className = "sh-select-search";
      searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.placeholder = searchPlaceholder;
      searchBox.appendChild(searchInput);
      popover.appendChild(searchBox);
    }

    const listEl = document.createElement("div");
    listEl.className = "sh-select-list";
    popover.appendChild(listEl);

    root.appendChild(trigger);
    root.appendChild(popover);

    let isOpen = false;
    let filterKeyword = "";

    const inst = {
      root,
      close() {
        if (!isOpen) return;
        isOpen = false;
        root.classList.remove("is-open");
        trigger.setAttribute("aria-expanded", "false");
        openPopovers.delete(inst);
      },
    };

    function open() {
      for (const other of openPopovers) {
        if (other !== inst) other.close();
      }
      isOpen = true;
      root.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      openPopovers.add(inst);
      if (searchInput) {
        searchInput.value = "";
        filterKeyword = "";
        renderList();
        setTimeout(() => searchInput.focus(), 10);
      } else {
        renderList();
      }
    }

    function updateTriggerLabel() {
      const found = options.find((o) => o.value === currentValue);
      if (found) {
        valueSpan.textContent = found.label;
        valueSpan.classList.remove("is-placeholder");
      } else {
        valueSpan.textContent = placeholder;
        valueSpan.classList.add("is-placeholder");
      }
    }

    function renderList() {
      listEl.innerHTML = "";
      const kw = filterKeyword.trim().toLowerCase();
      const filtered = options.filter((o) => {
        if (!kw) return true;
        const l = (o.label || "").toLowerCase();
        const v = (o.value || "").toLowerCase();
        const s = (o.sub || "").toLowerCase();
        return l.includes(kw) || v.includes(kw) || s.includes(kw);
      });

      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sh-select-empty";
        empty.textContent = "无匹配项";
        listEl.appendChild(empty);
        return;
      }

      let lastGroup = null;
      for (let i = 0; i < filtered.length; i++) {
        const item = filtered[i];
        if (item.group && item.group !== lastGroup) {
          lastGroup = item.group;
          const g = document.createElement("div");
          g.className = "sh-select-group-title";
          g.textContent = item.group;
          listEl.appendChild(g);
        }

        const optBtn = document.createElement("button");
        optBtn.type = "button";
        optBtn.className = item.value === currentValue
          ? "sh-select-option is-selected"
          : "sh-select-option";

        const leftWrap = document.createElement("span");
        leftWrap.textContent = item.label;

        const rightWrap = document.createElement("span");
        rightWrap.style.display = "inline-flex";
        rightWrap.style.alignItems = "center";
        rightWrap.style.gap = "6px";

        if (item.sub) {
          const subSpan = document.createElement("span");
          subSpan.className = "sh-select-option-sub";
          subSpan.textContent = item.sub;
          rightWrap.appendChild(subSpan);
        }

        const checkSpan = document.createElement("span");
        checkSpan.className = "sh-select-check";
        checkSpan.innerHTML = ICONS.check;
        rightWrap.appendChild(checkSpan);

        optBtn.appendChild(leftWrap);
        optBtn.appendChild(rightWrap);

        optBtn.addEventListener("click", () => {
          currentValue = item.value;
          updateTriggerLabel();
          inst.close();
          if (typeof onChange === "function") {
            onChange(currentValue, item);
          }
        });

        listEl.appendChild(optBtn);
      }
    }

    trigger.addEventListener("click", () => {
      if (isOpen) inst.close();
      else open();
    });

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        filterKeyword = searchInput.value;
        renderList();
      });
    }

    updateTriggerLabel();
    renderList();

    return {
      el: root,
      getValue: () => currentValue,
      setValue(val, silent) {
        currentValue = typeof val === "string" ? val : "";
        updateTriggerLabel();
        renderList();
        if (!silent && typeof onChange === "function") {
          const found = options.find((o) => o.value === currentValue);
          onChange(currentValue, found || null);
        }
      },
      setOptions(nextOptions) {
        options = Array.isArray(nextOptions) ? nextOptions.slice() : [];
        updateTriggerLabel();
        renderList();
      },
    };
  }

  // 创建自定义 shadcn Tabs 组件
  function createTabs(opts) {
    const items = Array.isArray(opts.items) ? opts.items : [];
    let activeKey = opts.value || (items[0] ? items[0].value : "");
    const onChange = opts.onChange;

    const bar = document.createElement("div");
    bar.className = "sh-tabs-list";
    bar.setAttribute("role", "tablist");

    const buttons = new Map();

    function setActive(val, silent) {
      activeKey = val;
      for (const [k, b] of buttons) {
        if (k === activeKey) b.classList.add("is-active");
        else b.classList.remove("is-active");
      }
      if (!silent && typeof onChange === "function") {
        onChange(activeKey);
      }
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = it.value === activeKey ? "sh-tabs-trigger is-active" : "sh-tabs-trigger";
      btn.setAttribute("role", "tab");
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        if (activeKey !== it.value) setActive(it.value, false);
      });
      buttons.set(it.value, btn);
      bar.appendChild(btn);
    }

    return {
      el: bar,
      getValue: () => activeKey,
      setValue: setActive,
    };
  }

  // 右下角 Sonner 风格通知提示
  function toast(opts) {
    const region = document.getElementById("sh-toast-region");
    if (!region) return;

    const title = (opts && opts.title) || "";
    const description = (opts && opts.description) || "";
    const inverted = opts && opts.inverted === true;

    const card = document.createElement("div");
    card.className = inverted ? "sh-toast sh-toast--inverted" : "sh-toast";

    const body = document.createElement("div");
    const tEl = document.createElement("div");
    tEl.className = "sh-toast-title";
    tEl.textContent = title;
    body.appendChild(tEl);

    if (description) {
      const dEl = document.createElement("div");
      dEl.className = "sh-toast-desc";
      dEl.textContent = description;
      body.appendChild(dEl);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sh-btn sh-btn--ghost sh-btn--icon";
    closeBtn.style.width = "22px";
    closeBtn.style.height = "22px";
    closeBtn.innerHTML = ICONS.close;

    function removeToast() {
      if (card.parentNode) {
        card.parentNode.removeChild(card);
      }
    }

    closeBtn.addEventListener("click", removeToast);
    card.appendChild(body);
    card.appendChild(closeBtn);
    region.appendChild(card);

    setTimeout(removeToast, 3200);
  }

  // 自定义模态确认对话框（完全替代原生 window.confirm）
  function confirmDialog(opts) {
    const backdrop = document.getElementById("sh-dialog-backdrop");
    const titleEl = document.getElementById("sh-dialog-title");
    const descEl = document.getElementById("sh-dialog-desc");
    const cancelBtn = document.getElementById("sh-dialog-cancel");
    const confirmBtn = document.getElementById("sh-dialog-confirm");
    if (!backdrop) return;

    titleEl.textContent = (opts && opts.title) || "确认操作";
    descEl.textContent = (opts && opts.description) || "";
    cancelBtn.textContent = (opts && opts.cancelText) || "取消";
    confirmBtn.textContent = (opts && opts.confirmText) || "确认";

    function close() {
      backdrop.classList.remove("is-open");
      cleanup();
    }

    function handleConfirm() {
      close();
      if (opts && typeof opts.onConfirm === "function") {
        opts.onConfirm();
      }
    }

    function handleBackdrop(ev) {
      if (ev.target === backdrop) close();
    }

    function handleKey(ev) {
      if (ev.key === "Escape") close();
    }

    function cleanup() {
      cancelBtn.removeEventListener("click", close);
      confirmBtn.removeEventListener("click", handleConfirm);
      backdrop.removeEventListener("mousedown", handleBackdrop);
      document.removeEventListener("keydown", handleKey);
    }

    cancelBtn.addEventListener("click", close);
    confirmBtn.addEventListener("click", handleConfirm);
    backdrop.addEventListener("mousedown", handleBackdrop);
    document.addEventListener("keydown", handleKey);
    backdrop.classList.add("is-open");
    confirmBtn.focus();
  }

  // 黑白单色系层次 JSON 语法高亮渲染
  function highlightJson(jsonText) {
    if (typeof jsonText !== "string") return "";
    const escaped = escapeHtml(jsonText);
    const tokenRegex = /(&quot;(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\&])*&quot;(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
    return escaped.replace(tokenRegex, (match) => {
      if (match.startsWith("&quot;")) {
        if (match.endsWith(":")) {
          return `<span class="jv-key">${match}</span>`;
        }
        return `<span class="jv-str">${match}</span>`;
      }
      if (match === "true" || match === "false") {
        return `<span class="jv-bool">${match}</span>`;
      }
      if (match === "null") {
        return `<span class="jv-null">${match}</span>`;
      }
      return `<span class="jv-num">${match}</span>`;
    });
  }

  // 复制文本到剪贴板并弹出 Toast
  async function copyText(text, successTitle) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast({ title: successTitle || "已复制到剪贴板" });
    } catch {
      toast({ title: "复制失败", description: "浏览器限制了剪贴板权限", inverted: true });
    }
  }

  window.WaylayUI = {
    ICONS,
    escapeHtml,
    createSwitch,
    createSelect,
    createTabs,
    toast,
    confirmDialog,
    highlightJson,
    copyText,
  };
})();
