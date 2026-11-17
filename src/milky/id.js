"use strict";

const crypto = require("crypto");

// Milky 协议标识符与资源临时链接辅助模块

const tempUrlCache = new Map();
const MAX_TEMP_URLS = 5000;

// 富媒体下载令牌注册表：token -> { msgId, chatType, peerUid, elementId, filePath }
const mediaTokenMap = new Map();
const mediaKeyToToken = new Map();
const MAX_MEDIA_TOKENS = 5000;

// 将数字或十进制数字文本反序列化为整型数值
function toIdNum(val) {
  if (typeof val === "number") {
    return Number.isFinite(val) ? Math.trunc(val) : 0;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        return typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

// 将数字或字符串标识符序列化为 NTQQ 内部使用的字符串键
function toIdKey(val) {
  if (typeof val === "string") return val;
  if (typeof val === "number" && Number.isFinite(val)) {
    return JSON.stringify(Math.trunc(val));
  }
  return "";
}

// 确保返回安全字符串
function ensureStr(val, fallback) {
  if (typeof val === "string") return val;
  if (typeof val === "number" && Number.isFinite(val)) {
    return JSON.stringify(val);
  }
  return typeof fallback === "string" ? fallback : "";
}

// 缓存 resource_id 到临时访问 URL 的映射，供 get_resource_temp_url 查询
function recordResourceUrl(resourceId, url) {
  if (!resourceId || !url) return;
  tempUrlCache.set(resourceId, url);
  if (tempUrlCache.size > MAX_TEMP_URLS) {
    const oldestKey = tempUrlCache.keys().next().value;
    tempUrlCache.delete(oldestKey);
  }
}

function getResourceUrl(resourceId) {
  if (typeof resourceId !== "string" || !resourceId) return "";
  return tempUrlCache.get(resourceId) || "";
}

// 注册 NTQQ 富媒体下载元数据并返回稳定随机令牌
function registerMediaDownload(meta) {
  const msgId = ensureStr(meta && meta.msgId, "");
  const elementId = ensureStr(meta && meta.elementId, "");
  const peerUid = ensureStr(meta && meta.peerUid, "");
  const chatType = toIdNum(meta && meta.chatType);
  const filePath = ensureStr(meta && meta.filePath, "");
  if (!msgId || !elementId || !peerUid || !chatType) return "";

  const compositeKey = `${chatType}:${peerUid}:${msgId}:${elementId}`;
  const existing = mediaKeyToToken.get(compositeKey);
  if (existing && mediaTokenMap.has(existing)) {
    if (filePath) {
      const prev = mediaTokenMap.get(existing);
      mediaTokenMap.set(existing, { ...prev, filePath });
    }
    return existing;
  }

  const token = crypto.randomBytes(16).toString("hex");
  mediaTokenMap.set(token, { key: compositeKey, msgId, chatType, peerUid, elementId, filePath });
  mediaKeyToToken.set(compositeKey, token);

  if (mediaTokenMap.size > MAX_MEDIA_TOKENS) {
    const oldestToken = mediaTokenMap.keys().next().value;
    const oldestEntry = mediaTokenMap.get(oldestToken);
    mediaTokenMap.delete(oldestToken);
    if (oldestEntry && oldestEntry.key) {
      mediaKeyToToken.delete(oldestEntry.key);
    }
  }
  return token;
}

function getMediaDownload(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  return mediaTokenMap.get(token) || null;
}

module.exports = {
  toIdNum,
  toIdKey,
  ensureStr,
  recordResourceUrl,
  getResourceUrl,
  registerMediaDownload,
  getMediaDownload,
};
