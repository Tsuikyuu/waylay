"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { promisify } = require("util");
const { toIdNum, toIdKey, ensureStr, recordResourceUrl, registerMediaDownload } = require("./id");

const execAsync = promisify(exec);
const IMAGE_HTTP_HOST = "https://gchat.qpic.cn";
const TEMP_DIR = "/tmp/waylay-media";

// 确保临时目录存在
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// 解析媒体文件引用到本地路径并返回元数据
async function resolveMediaFile(file, defaultExt) {
  if (typeof file !== "string" || !file) return null;

  // 处理 base64 编码数据
  if (file.startsWith("base64://")) {
    const b64 = file.slice(9);
    const buf = Buffer.from(b64, "base64");
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const ext = defaultExt || detectImageExt(buf);
    const filePath = path.join(TEMP_DIR, `${md5}.${ext}`);
    fs.writeFileSync(filePath, buf);
    return { path: filePath, size: buf.length, md5 };
  }

  // 处理 HTTP(S) 链接，异步下载避免阻塞事件循环
  if (file.startsWith("http://") || file.startsWith("https://")) {
    const urlMd5 = crypto.createHash("md5").update(file).digest("hex");
    const filePath = path.join(TEMP_DIR, `${urlMd5}.tmp`);
    try {
      await execAsync(`curl -fsSL -o "${filePath}" "${file}"`, { timeout: 60000 });
      const buf = fs.readFileSync(filePath);
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      const ext = defaultExt || detectExtFromName(file) || detectImageExt(buf);
      const finalPath = path.join(TEMP_DIR, `${md5}.${ext}`);
      if (finalPath !== filePath) fs.renameSync(filePath, finalPath);
      return { path: finalPath, size: buf.length, md5 };
    } catch (e) {
      console.error("[milky-message] 下载文件失败:", e.message);
      return null;
    }
  }

  // 处理 file:// 协议路径
  if (file.startsWith("file://")) {
    const localPath = file.slice(7);
    if (fs.existsSync(localPath)) {
      const buf = fs.readFileSync(localPath);
      const md5 = crypto.createHash("md5").update(buf).digest("hex");
      return { path: localPath, size: buf.length, md5 };
    }
    console.warn(`[milky-message] 未找到本地文件: ${localPath.substring(0, 120)}`);
    return null;
  }

  // 处理直接本地路径
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    return { path: file, size: buf.length, md5 };
  }

  return null;
}

// 解析图片文件，校验图片魔数并读取宽高尺寸
async function resolveImageFile(file) {
  const resolved = await resolveMediaFile(file);
  if (!resolved) return null;
  const buf = fs.readFileSync(resolved.path);
  if (!isImageData(buf)) {
    console.warn(`[milky-message] 拒绝非图片数据 (${buf.length} 字节)`);
    return null;
  }
  const dim = getImageDimensions(buf);
  return { ...resolved, ...dim };
}

function isImageData(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // PNG
  if (buf[0] === 0xFF && buf[1] === 0xD8) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49) return true; // WEBP
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true; // BMP
  return false;
}

function detectExtFromName(name) {
  const m = name.match(/\.(\w{2,5})(?:[?#]|$)/);
  return m ? m[1].toLowerCase() : null;
}

function detectImageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "png";
}

function getImageDimensions(buf) {
  try {
    // PNG 宽高位于偏移 16 和 20（大端序 uint32）
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG 扫描 SOF0/SOF2 标记
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      for (let i = 2; i < buf.length - 8; i++) {
        if (buf[i] === 0xFF && (buf[i + 1] === 0xC0 || buf[i + 1] === 0xC2)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

// ---- NTQQ 消息元素转换为 Milky IncomingSegment 数组 ----

function ntToMilky(elements, msg, uinByUidResolver, mediaUrlBuilder) {
  const segments = [];
  if (!elements || !Array.isArray(elements)) return segments;

  for (let i = 0; i < elements.length; i++) {
    const seg = convertElementToMilky(elements[i], msg, uinByUidResolver, mediaUrlBuilder);
    if (seg) {
      if (Array.isArray(seg)) segments.push(...seg);
      else segments.push(seg);
    }
  }
  return segments;
}

function convertElementToMilky(el, msg, uinByUidResolver, mediaUrlBuilder) {
  if (el.textElement) {
    const te = el.textElement;
    if (te.atType === 1) {
      return { type: "mention_all", data: {} };
    }
    if (te.atType === 2) {
      let resolvedUin = "";
      if (te.atNtUid && typeof uinByUidResolver === "function") {
        resolvedUin = uinByUidResolver(te.atNtUid) || "";
      }
      if (!resolvedUin && te.atUid && te.atUid !== "0" && !te.atUid.startsWith("u_")) {
        resolvedUin = te.atUid;
      }
      if (!resolvedUin && typeof te.content === "string") {
        resolvedUin = te.content.replace(/^@/, "");
      }
      return {
        type: "mention",
        data: { user_id: toIdNum(resolvedUin) },
      };
    }
    if (!te.content) return null;
    return { type: "text", data: { text: te.content } };
  }

  if (el.replyElement) {
    // message_seq 随后由事件转换器根据历史映射回填
    return {
      type: "reply",
      data: { message_seq: 0 },
    };
  }

  if (el.picElement) {
    const pe = el.picElement;
    let tempUrl = "";
    if (typeof mediaUrlBuilder === "function" && msg && msg.msgId && el.elementId) {
      const fallbackPath = pe.sourcePath || path.join(TEMP_DIR, `${pe.md5HexStr || el.elementId}.img`);
      const token = registerMediaDownload({
        msgId: msg.msgId,
        chatType: msg.chatType,
        peerUid: msg.peerUid,
        elementId: el.elementId,
        filePath: fallbackPath,
      });
      if (token) {
        tempUrl = mediaUrlBuilder(token);
      }
    }
    if (!tempUrl && pe.originImageUrl) {
      tempUrl = pe.originImageUrl.startsWith("http")
        ? pe.originImageUrl
        : IMAGE_HTTP_HOST + pe.originImageUrl;
    }
    const resourceId = pe.md5HexStr || pe.fileUuid || pe.fileName || "";
    if (resourceId && tempUrl) {
      recordResourceUrl(resourceId, tempUrl);
    }
    return {
      type: "image",
      data: {
        resource_id: resourceId,
        temp_url: tempUrl,
        width: toIdNum(pe.picWidth),
        height: toIdNum(pe.picHeight),
        summary: pe.summary || "[图片]",
        sub_type: pe.picSubType === 1 ? "sticker" : "normal",
      },
    };
  }

  if (el.videoElement) {
    const ve = el.videoElement;
    const resourceId = ve.fileUuid || ve.videoMd5 || ve.fileName || "";
    const tempUrl = ve.filePath ? `file://${ve.filePath}` : "";
    if (resourceId && tempUrl) recordResourceUrl(resourceId, tempUrl);
    return {
      type: "video",
      data: {
        resource_id: resourceId,
        temp_url: tempUrl,
        width: toIdNum(ve.thumbWidth),
        height: toIdNum(ve.thumbHeight),
        duration: toIdNum(ve.fileTime),
      },
    };
  }

  if (el.fileElement) {
    const fe = el.fileElement;
    return {
      type: "file",
      data: {
        file_id: fe.fileUuid || "",
        file_name: fe.fileName || "",
        file_size: toIdNum(fe.fileSize),
      },
    };
  }

  if (el.pttElement) {
    const ptt = el.pttElement;
    const resourceId = ptt.fileUuid || ptt.md5HexStr || ptt.fileName || "";
    const tempUrl = ptt.filePath ? `file://${ptt.filePath}` : "";
    if (resourceId && tempUrl) recordResourceUrl(resourceId, tempUrl);
    return {
      type: "record",
      data: {
        resource_id: resourceId,
        temp_url: tempUrl,
        duration: toIdNum(ptt.duration),
      },
    };
  }

  if (el.arkElement) {
    const rawJson = el.arkElement.bytesData || "{}";
    try {
      const data = JSON.parse(rawJson);
      if (data.app === "com.tencent.multimsg") {
        return { type: "forward", data: { forward_id: ensureStr(msg?.msgId, "0") } };
      }
      return {
        type: "light_app",
        data: { app_name: data.app || "", json_payload: rawJson },
      };
    } catch {}
    return {
      type: "light_app",
      data: { app_name: "", json_payload: rawJson },
    };
  }

  if (el.faceElement) {
    return {
      type: "face",
      data: {
        face_id: toIdKey(el.faceElement.faceIndex || 0),
        is_large: el.faceElement.faceType === 3,
      },
    };
  }

  if (el.marketFaceElement) {
    const mf = el.marketFaceElement;
    const emojiId = typeof mf.emojiId === "string" ? mf.emojiId : "";
    const summary = typeof mf.faceName === "string" && mf.faceName !== "" ? mf.faceName : "[商城表情]";
    if (emojiId.length < 2) {
      return { type: "text", data: { text: summary } };
    }
    const dir = emojiId.substring(0, 2);
    // 将商城表情输出为 sticker 类型的图片段并使用 300x300.png 明文资源链接，兼容未实现 market_face 的下游适配器
    const tempUrl = `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/300x300.png`;
    recordResourceUrl(emojiId, tempUrl);
    return {
      type: "image",
      data: {
        resource_id: emojiId,
        temp_url: tempUrl,
        width: toIdNum(mf.imageWidth) || 300,
        height: toIdNum(mf.imageHeight) || 300,
        summary,
        sub_type: "sticker",
      },
    };
  }

  if (el.markdownElement) {
    return {
      type: "xml",
      data: {
        service_id: 60,
        xml_payload: el.markdownElement.content || "",
      },
    };
  }

  if (el.multiForwardMsgElement) {
    return { type: "forward", data: { forward_id: ensureStr(msg?.msgId, "0") } };
  }

  return null;
}

// ---- Milky OutgoingSegment 数组转换为 NTQQ 发送元素 ----

async function milkyToNt(segments, uidResolver) {
  if (!Array.isArray(segments)) return [];

  const elements = [];
  for (let i = 0; i < segments.length; i++) {
    const el = await convertMilkySegment(segments[i], uidResolver);
    if (el) elements.push(el);
  }
  return elements;
}

async function convertMilkySegment(seg, uidResolver) {
  if (!seg || typeof seg !== "object") return null;
  const d = seg.data || {};

  switch (seg.type) {
    case "text":
      return {
        elementType: 1,
        elementId: "",
        textElement: {
          content: ensureStr(d.text, ""),
          atType: 0,
          atUid: "",
          atTinyId: "",
          atNtUid: "",
        },
      };

    case "mention": {
      const userId = toIdKey(d.user_id);
      const resolved = typeof uidResolver === "function" ? uidResolver(userId) : null;
      const uid = typeof resolved === "string" ? resolved : (resolved?.uid || "");
      const name = (typeof resolved === "object" && resolved ? resolved.name : null) || userId;
      return {
        elementType: 1,
        elementId: "",
        textElement: {
          content: `@${name}`,
          atType: 2,
          atUid: uid || userId,
          atTinyId: "",
          atNtUid: uid,
        },
      };
    }

    case "mention_all":
      return {
        elementType: 1,
        elementId: "",
        textElement: {
          content: "@全体成员",
          atType: 1,
          atUid: "0",
          atTinyId: "",
          atNtUid: "all",
        },
      };

    case "face":
      return {
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: toIdNum(d.face_id),
          faceType: d.is_large ? 3 : 1,
          sourceType: 1,
        },
      };

    case "reply":
      return {
        elementType: 7,
        elementId: "",
        replyElement: {
          replayMsgSeq: "0",
          replayMsgId: toIdKey(d.message_seq || 0),
          senderUin: "0",
          senderUinStr: "0",
        },
      };

    case "image": {
      const fileRef = d.uri || d.url || d.file_id || "";
      const resolved = await resolveImageFile(fileRef);
      if (!resolved) return null;
      return {
        elementType: 2,
        elementId: "",
        picElement: {
          md5HexStr: resolved.md5,
          fileSize: toIdKey(resolved.size),
          fileName: path.basename(resolved.path),
          sourcePath: resolved.path,
          original: true,
          picType: 1000,
          picSubType: d.sub_type === "sticker" ? 1 : 0,
          picWidth: resolved.width || 0,
          picHeight: resolved.height || 0,
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          summary: ensureStr(d.summary, "[图片]"),
        },
      };
    }

    case "record": {
      const fileRef = d.uri || d.url || d.file_id || "";
      const resolved = await resolveMediaFile(fileRef, "amr");
      if (!resolved) return null;
      return {
        elementType: 4,
        elementId: "",
        pttElement: {
          fileName: path.basename(resolved.path),
          filePath: resolved.path,
          md5HexStr: resolved.md5,
          fileSize: toIdKey(resolved.size),
          duration: 5,
          formatType: 1,
          voiceType: 1,
          voiceChangeType: 0,
          canConvert2Text: true,
          waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
          fileSubId: "",
          playState: 1,
          autoConvertText: 0,
        },
      };
    }

    case "video": {
      const fileRef = d.uri || d.url || d.file_id || "";
      const resolved = await resolveMediaFile(fileRef, "mp4");
      if (!resolved) return null;
      return {
        elementType: 5,
        elementId: "",
        videoElement: {
          fileName: path.basename(resolved.path),
          filePath: resolved.path,
          videoMd5: resolved.md5,
          fileSize: toIdKey(resolved.size),
        },
      };
    }

    case "light_app":
      return {
        elementType: 10,
        elementId: "",
        arkElement: {
          bytesData: ensureStr(d.json_payload || d.json_data, "{}"),
          linkInfo: null,
          subElementType: null,
        },
      };

    default:
      return null;
  }
}

module.exports = { ntToMilky, milkyToNt, resolveMediaFile, resolveImageFile };
