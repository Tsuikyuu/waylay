"use strict";

// 内存环形日志收集器，拦截控制台输出并支持实时流式分发

const MAX_LOG_ENTRIES = 600;
const logBuffer = [];
const subscribers = new Set();
let nextLogId = 1;
let installed = false;

// 将单个日志参数序列化为可读文本
function serializeArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (arg instanceof Error) {
    return arg.stack || arg.message || "Error";
  }
  try {
    const json = JSON.stringify(arg);
    if (typeof json === "string") return json;
    return "[Unserializable]";
  } catch {
    return "[Circular]";
  }
}

// 从日志首段提取方括号模块标签，如 [bridge] -> bridge
function extractTag(text) {
  const match = text.match(/^\[([a-zA-Z0-9_-]+)\]\s*/);
  if (match) {
    return {
      tag: match[1].toLowerCase(),
      body: text.slice(match[0].length),
    };
  }
  return {
    tag: "app",
    body: text,
  };
}

function appendEntry(level, args) {
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    parts.push(serializeArg(args[i]));
  }
  const rawText = parts.join(" ");
  const parsed = extractTag(rawText);

  const entry = {
    id: nextLogId++,
    ts: Date.now(),
    level,
    tag: parsed.tag,
    text: parsed.body,
    raw: rawText,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }

  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      subscribers.delete(fn);
    }
  }
}

// 安装全局控制台拦截器
function installLogger() {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    origLog(...args);
    appendEntry("info", args);
  };

  console.info = (...args) => {
    origInfo(...args);
    appendEntry("info", args);
  };

  console.warn = (...args) => {
    origWarn(...args);
    appendEntry("warn", args);
  };

  console.error = (...args) => {
    origError(...args);
    appendEntry("error", args);
  };
}

function getLogs() {
  return logBuffer.slice();
}

function clearLogs() {
  logBuffer.length = 0;
}

function subscribeLogs(listener) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

module.exports = {
  installLogger,
  getLogs,
  clearLogs,
  subscribeLogs,
};
