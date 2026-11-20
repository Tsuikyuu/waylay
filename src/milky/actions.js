"use strict";

const fs = require("fs");
const path = require("path");
const { milkyToNt } = require("./message");
const { toIdNum, toIdKey, ensureStr, getResourceUrl } = require("./id");
const { VERSION } = require("../version");

const handlers = {};

// ---- 系统与个人信息 API ----

handlers.get_login_info = async (params, bridge) => {
  const uinNum = toIdNum(bridge.selfInfo.uin);
  if (uinNum <= 0) {
    throw new Error("QQ login not ready");
  }
  if (!bridge.selfInfo.nickName && bridge.session && bridge.selfInfo.uid) {
    try {
      const nickMap = bridge.session.getBuddyService().getBuddyNick([bridge.selfInfo.uid]);
      const fetched = nickMap && typeof nickMap.get === "function" ? nickMap.get(bridge.selfInfo.uid) : "";
      if (fetched) {
        bridge.selfInfo.nickName = fetched;
      }
    } catch {}
  }
  return {
    uin: uinNum,
    nickname: bridge.selfInfo.nickName || toIdKey(uinNum),
  };
};

handlers.get_impl_info = async (params, bridge) => {
  const plat = process.platform === "win32"
    ? "windows"
    : (process.platform === "darwin" ? "macos" : "linux");
  return {
    impl_name: "waylay",
    impl_version: VERSION,
    qq_protocol_version: (bridge.packageJSON && bridge.packageJSON.version) || "",
    qq_protocol_type: plat,
    milky_version: "1.0",
  };
};

handlers.get_user_profile = async (params, bridge) => {
  const userIdStr = toIdKey(params.user_id);
  const userIdNum = toIdNum(params.user_id);
  const emptyProfile = {
    user_id: userIdNum,
    nickname: "",
    qid: "",
    age: 0,
    sex: "unknown",
    remark: "",
    bio: "",
    level: 0,
    country: "",
    city: "",
    school: "",
  };
  if (!bridge.session || !userIdStr) return emptyProfile;
  try {
    const profileService = bridge.session.getProfileService();
    const uids = await profileService.getUidByUin("FriendsServiceImpl", [userIdStr]);
    const uid = uids?.uidInfo?.get(userIdStr) || "";
    if (uid) {
      const profiles = await profileService.getUserSimpleInfo(false, [uid]);
      const p = profiles?.profileMap?.get(uid) || profiles?.get?.(uid);
      if (p) {
        return {
          ...emptyProfile,
          nickname: p.nick || p.nickName || "",
          remark: p.remark || "",
          bio: p.longNick || "",
        };
      }
    }
  } catch {}
  return emptyProfile;
};

// ---- 好友相关 API ----

handlers.get_friend_list = async (params, bridge, eventTranslator) => {
  const cached = eventTranslator.getBuddyList();
  if (cached.size > 0 && !params.no_cache) {
    const friends = [];
    for (const [uin] of cached) {
      friends.push(eventTranslator.buildFriendEntity(uin));
    }
    return { friends };
  }
  try {
    const buddyList = await bridge.session?.getBuddyService().getBuddyList(true);
    if (Array.isArray(buddyList?.data)) {
      eventTranslator._translateBuddyEvent("onBuddyListChange", buddyList.data);
    }
  } catch {}
  const friends = [];
  for (const [uin] of eventTranslator.getBuddyList()) {
    friends.push(eventTranslator.buildFriendEntity(uin));
  }
  return { friends };
};

handlers.get_friend_info = async (params, bridge, eventTranslator) => {
  return {
    friend: eventTranslator.buildFriendEntity(params.user_id),
  };
};

// ---- 群聊相关 API ----

handlers.get_group_list = async (params, bridge, eventTranslator) => {
  let rawGroups = eventTranslator.getGroupList();
  if (rawGroups.length === 0 || params.no_cache) {
    try {
      await bridge.session?.getGroupService().getGroupList(true);
      rawGroups = eventTranslator.getGroupList();
    } catch {}
  }
  const groups = [];
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i];
    groups.push(eventTranslator.buildGroupEntity(g.groupCode, g.groupName));
  }
  return { groups };
};

handlers.get_group_info = async (params, bridge, eventTranslator) => {
  return {
    group: eventTranslator.buildGroupEntity(params.group_id),
  };
};

async function fetchGroupMembersAndWait(bridge, groupIdStr) {
  const groupService = bridge.session.getGroupService();
  try {
    const sceneId = groupService.createMemberListScene(groupIdStr, `milky_fetch_${Date.now()}`);
    await groupService.getNextMemberList(sceneId, undefined, 3000);
    try { groupService.destroyMemberListScene(sceneId); } catch {}
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

handlers.get_group_member_list = async (params, bridge, eventTranslator) => {
  const groupIdStr = toIdKey(params.group_id);
  if (!bridge.session || !groupIdStr) return { members: [] };

  let cached = eventTranslator._groupMembers.get(groupIdStr);
  if (!cached || cached.size === 0 || params.no_cache) {
    await fetchGroupMembersAndWait(bridge, groupIdStr);
    cached = eventTranslator._groupMembers.get(groupIdStr);
  }
  if (!cached || cached.size === 0) return { members: [] };

  const members = [];
  for (const [uin] of cached) {
    members.push(eventTranslator.buildGroupMemberEntity(groupIdStr, uin));
  }
  return { members };
};

handlers.get_group_member_info = async (params, bridge, eventTranslator) => {
  const groupIdStr = toIdKey(params.group_id);
  const userIdStr = toIdKey(params.user_id);
  if (!bridge.session || !groupIdStr || !userIdStr) {
    return { member: eventTranslator.buildGroupMemberEntity(groupIdStr, userIdStr) };
  }

  let member = eventTranslator.getGroupMember(groupIdStr, userIdStr);
  if (!member || params.no_cache) {
    const groupCache = eventTranslator._groupMembers.get(groupIdStr);
    if (!groupCache || groupCache.size === 0 || params.no_cache) {
      await fetchGroupMembersAndWait(bridge, groupIdStr);
    }
  }
  return {
    member: eventTranslator.buildGroupMemberEntity(groupIdStr, userIdStr),
  };
};

// ---- 消息收发与撤回 API ----

// 将好友或临时会话 QQ 号解析为 NTQQ 内核所需的 peerUid
async function resolvePrivatePeerUid(userIdStr, bridge, eventTranslator) {
  let peerUid = eventTranslator.getUidByUin(userIdStr);
  if (!peerUid && bridge.session) {
    try {
      const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userIdStr]);
      peerUid = r?.uidInfo?.get(userIdStr) || null;
      if (peerUid) eventTranslator.recordUinUid(userIdStr, peerUid);
    } catch {}
  }
  if (!peerUid && bridge.session) {
    try {
      const buddyService = bridge.session.getBuddyService();
      const buddyList = await buddyService.getBuddyList(true);
      for (const cat of buddyList?.data || []) {
        for (const buddy of cat.buddyList || []) {
          if (toIdKey(buddy.uin) === userIdStr) {
            peerUid = buddy.uid;
            eventTranslator.recordUinUid(userIdStr, buddy.uid);
            break;
          }
        }
        if (peerUid) break;
      }
    } catch {}
  }
  return peerUid || userIdStr;
}

handlers.send_private_message = async (params, bridge, eventTranslator) => {
  const userIdStr = toIdKey(params.user_id);
  const peerUid = await resolvePrivatePeerUid(userIdStr, bridge, eventTranslator);
  const peer = { chatType: 1, peerUid, guildId: "" };
  const segs = Array.isArray(params.message) ? params.message : (Array.isArray(params.segments) ? params.segments : []);
  return await sendMessage(peer, segs, bridge, eventTranslator);
};

handlers.send_group_message = async (params, bridge, eventTranslator) => {
  const groupIdStr = toIdKey(params.group_id);
  const peer = { chatType: 2, peerUid: groupIdStr, guildId: "" };
  const segs = Array.isArray(params.message) ? params.message : (Array.isArray(params.segments) ? params.segments : []);
  return await sendMessage(peer, segs, bridge, eventTranslator);
};

async function sendMessage(peer, segments, bridge, eventTranslator) {
  if (!bridge.session) throw new Error("Session not ready");
  if (!Array.isArray(segments)) segments = [];

  // 解析提及段所需的 UID 与群名片
  const mentionMap = new Map();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg.type !== "mention") continue;
    const userIdStr = toIdKey(seg.data?.user_id);
    if (!userIdStr || mentionMap.has(userIdStr)) continue;

    if (peer.chatType === 2) {
      const member = eventTranslator.getGroupMember(peer.peerUid, userIdStr);
      if (member?.uid) {
        mentionMap.set(userIdStr, { uid: member.uid, name: member.card || member.nick || null });
        continue;
      }
    }
    let uid = eventTranslator.getUidByUin(userIdStr);
    if (!uid) {
      try {
        const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userIdStr]);
        uid = r?.uidInfo?.get(userIdStr) || null;
        if (uid) eventTranslator.recordUinUid(userIdStr, uid);
      } catch {}
    }
    mentionMap.set(userIdStr, { uid: uid || "", name: null });
  }

  const uidResolver = mentionMap.size > 0
    ? (uin) => mentionMap.get(uin) || { uid: "", name: null }
    : null;

  const elements = await milkyToNt(segments, uidResolver);
  if (!elements.length) throw new Error("Empty message");

  // 将引用回复的 message_seq 还原为 NTQQ 真实 msgId
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.elementType === 7 && el.replyElement) {
      const seq = toIdNum(el.replyElement.replayMsgId);
      const realMsgId = eventTranslator.resolveSeq(seq);
      if (realMsgId) {
        el.replyElement.replayMsgId = realMsgId;
      }
      const meta = eventTranslator.getCachedNtMeta(seq);
      if (meta) {
        el.replyElement.replayMsgSeq = meta.ntMsgSeq || "0";
        el.replyElement.senderUin = meta.senderUinStr || "0";
        el.replyElement.senderUinStr = meta.senderUinStr || "0";
      }
    }
  }

  // 注册富媒体文件路径
  const msgService = bridge.session.getMsgService();
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    try {
      if (el.elementType === 2 && el.picElement?.sourcePath) {
        const mediaPath = registerMedia(msgService, el.picElement.md5HexStr, el.picElement.fileName, 2);
        if (mediaPath) {
          fs.copyFileSync(el.picElement.sourcePath, mediaPath);
          el.picElement.sourcePath = mediaPath;
        }
      } else if (el.elementType === 5 && el.videoElement?.filePath) {
        const mediaPath = registerMedia(msgService, el.videoElement.videoMd5, el.videoElement.fileName, 5);
        if (mediaPath) {
          fs.copyFileSync(el.videoElement.filePath, mediaPath);
          el.videoElement.filePath = mediaPath;
        }
      } else if (el.elementType === 4 && el.pttElement?.filePath) {
        const mediaPath = registerMedia(msgService, el.pttElement.md5HexStr, el.pttElement.fileName, 4);
        if (mediaPath) {
          fs.copyFileSync(el.pttElement.filePath, mediaPath);
          el.pttElement.filePath = mediaPath;
        }
      }
    } catch (e) {
      console.warn(`[milky-actions] 注册富媒体异常 (type ${el.elementType}):`, e.message);
    }
  }

  let msgId = "0";
  try {
    if (typeof msgService.generateMsgUniqueId === "function") {
      const generated = msgService.generateMsgUniqueId(peer.chatType, ensureStr(Date.now(), ""));
      if (typeof generated === "string" && generated !== "" && generated !== "0") {
        msgId = generated;
      }
    }
  } catch {}

  const preAllocatedSeq = msgId !== "0" ? eventTranslator.createSeq(msgId) : 0;
  const result = await msgService.sendMsg(msgId, peer, elements, new Map());
  if (result && typeof result.result === "number" && result.result !== 0) {
    throw new Error(result.errMsg || `sendMsg failed (${result.result})`);
  }
  const returnedMsgId = ensureStr(result?.msgId || result?.result?.msgId, "");
  const seq = preAllocatedSeq > 0
    ? preAllocatedSeq
    : eventTranslator.createSeq(returnedMsgId);
  return {
    message_seq: seq,
    time: Math.floor(Date.now() / 1000),
  };
}

function registerMedia(msgService, md5, fileName, elementType) {
  const pathInfo = {
    md5HexStr: md5 || "",
    fileName: fileName || "",
    elementType,
    elementSubType: 0,
    thumbSize: 0,
    needCreate: true,
    downloadType: 1,
    file_uuid: "",
  };
  const mediaPath = msgService.getRichMediaFilePathForGuild(pathInfo);
  if (mediaPath) {
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  }
  return mediaPath || null;
}

handlers.recall_private_message = async (params, bridge, eventTranslator) => {
  const seq = toIdNum(params.message_seq);
  const msgId = eventTranslator.resolveSeq(seq);
  if (!msgId || !bridge.session) return {};
  const userIdStr = toIdKey(params.user_id);
  const peerUid = eventTranslator.getUidByUin(userIdStr) || userIdStr;
  try {
    await bridge.session.getMsgService().recallMsg({ chatType: 1, peerUid, guildId: "" }, [msgId]);
  } catch (e) {
    console.error("[milky-actions] recall_private_message 出错:", e.message);
  }
  return {};
};

handlers.recall_group_message = async (params, bridge, eventTranslator) => {
  const seq = toIdNum(params.message_seq);
  const msgId = eventTranslator.resolveSeq(seq);
  if (!msgId || !bridge.session) return {};
  const groupIdStr = toIdKey(params.group_id);
  try {
    await bridge.session.getMsgService().recallMsg({ chatType: 2, peerUid: groupIdStr, guildId: "" }, [msgId]);
  } catch (e) {
    console.error("[milky-actions] recall_group_message 出错:", e.message);
  }
  return {};
};

handlers.get_message = async (params, bridge, eventTranslator) => {
  const seq = toIdNum(params.message_seq);
  const cached = eventTranslator.getCachedMsg(seq);
  if (!cached) {
    throw new Error("Message not found");
  }
  return { message: cached };
};

handlers.get_history_messages = async (params, bridge, eventTranslator) => {
  const scene = ensureStr(params.message_scene, "group");
  const peerIdNum = toIdNum(params.peer_id);
  const peerIdStr = toIdKey(params.peer_id);
  if (peerIdNum <= 0 || !peerIdStr) {
    throw new Error("Invalid peer_id");
  }

  const rawLimit = toIdNum(params.limit);
  const limit = rawLimit > 0 ? (rawLimit > 100 ? 100 : rawLimit) : 20;
  const startSeq = params.start_message_seq !== undefined && params.start_message_seq !== null
    ? toIdNum(params.start_message_seq)
    : 0;

  let peer = null;
  if (scene === "group") {
    peer = { chatType: 2, peerUid: peerIdStr, guildId: "" };
  } else if (scene === "friend") {
    const peerUid = await resolvePrivatePeerUid(peerIdStr, bridge, eventTranslator);
    peer = { chatType: 1, peerUid, guildId: "" };
  } else if (scene === "temp") {
    const peerUid = await resolvePrivatePeerUid(peerIdStr, bridge, eventTranslator);
    peer = { chatType: 100, peerUid, guildId: "" };
  } else {
    throw new Error(`Unsupported message_scene: ${scene}`);
  }

  let converted = [];
  const msgService = bridge.session ? bridge.session.getMsgService() : null;
  if (msgService && typeof msgService.getMsgsIncludeSelf === "function") {
    try {
      const fetchCount = limit + 15 > 100 ? 100 : limit + 15;
      const anchorMsgId = startSeq > 0 ? eventTranslator.resolveSeq(startSeq) : undefined;
      let res = null;
      if (startSeq <= 0) {
        res = await msgService.getMsgsIncludeSelf(peer, "0", fetchCount, true);
      } else if (anchorMsgId) {
        res = await msgService.getMsgsIncludeSelf(peer, anchorMsgId, fetchCount, false);
      } else {
        const wideCount = fetchCount > 50 ? fetchCount : 50;
        res = await msgService.getMsgsIncludeSelf(peer, "0", wideCount, true);
      }

      const rawList = Array.isArray(res?.msgList) ? res.msgList : [];
      for (let i = 0; i < rawList.length; i++) {
        const item = eventTranslator.toIncomingMessage(rawList[i], { fallbackPeerId: peerIdStr });
        if (!item) continue;
        if (startSeq > 0 && !anchorMsgId && item.message_seq > startSeq) continue;
        converted.push(item);
      }

      // getMsgsIncludeSelf 传入锚点向前查询时不含锚点本身，按 Milky 规范补齐有效锚点消息
      if (startSeq > 0 && anchorMsgId) {
        const anchorItem = eventTranslator.getCachedMsg(startSeq);
        if (
          anchorItem &&
          anchorItem.message_scene === scene &&
          anchorItem.peer_id === peerIdNum &&
          !converted.some((m) => m.message_seq === startSeq)
        ) {
          converted.push(anchorItem);
        }
      }
    } catch (e) {
      console.warn("[milky-actions] get_history_messages 内核查询失败，回退内存缓存:", e.message);
    }
  }

  if (converted.length === 0) {
    converted = eventTranslator.getCachedHistory(scene, peerIdNum, startSeq);
  }

  if (converted.length > limit) {
    const startIndex = converted.length - limit;
    const olderItem = converted[startIndex - 1];
    const messages = converted.slice(startIndex);
    return olderItem && olderItem.message_seq > 0
      ? { messages, next_message_seq: olderItem.message_seq }
      : { messages };
  }

  return { messages: converted };
};

handlers.get_resource_temp_url = async (params) => {
  const resId = ensureStr(params.resource_id, "");
  return { url: getResourceUrl(resId) };
};

// ---- 群管理操作 API（均按规范返回空对象 {}） ----

handlers.set_group_name = async (params, bridge) => {
  if (!bridge.session) return {};
  const name = ensureStr(params.new_group_name || params.group_name, "");
  try {
    bridge.session.getGroupService().modifyGroupName(toIdKey(params.group_id), name);
  } catch {}
  return {};
};

handlers.set_group_member_card = async (params, bridge) => {
  if (!bridge.session) return {};
  try {
    bridge.session.getGroupService().modifyMemberCardName(
      toIdKey(params.group_id),
      toIdKey(params.user_id),
      ensureStr(params.card, "")
    );
  } catch {}
  return {};
};

handlers.set_group_member_admin = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const groupIdStr = toIdKey(params.group_id);
  const userIdStr = toIdKey(params.user_id);
  const uid = eventTranslator.getUidByUin(userIdStr) || userIdStr;
  const isSet = params.is_set !== undefined ? params.is_set !== false : params.is_admin !== false;
  try {
    bridge.session.getGroupService().setMemberRole(groupIdStr, uid, isSet ? 3 : 2);
  } catch {}
  return {};
};

handlers.set_group_member_mute = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const groupIdStr = toIdKey(params.group_id);
  const userIdStr = toIdKey(params.user_id);
  const uid = eventTranslator.getUidByUin(userIdStr) || userIdStr;
  try {
    bridge.session.getGroupService().setMemberShutUp(
      groupIdStr,
      [{ uid, timeStamp: toIdNum(params.duration) }]
    );
  } catch {}
  return {};
};

handlers.set_group_whole_mute = async (params, bridge) => {
  if (!bridge.session) return {};
  try {
    bridge.session.getGroupService().setGroupShutUp(toIdKey(params.group_id), params.is_mute !== false);
  } catch {}
  return {};
};

handlers.kick_group_member = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const groupIdStr = toIdKey(params.group_id);
  const userIdStr = toIdKey(params.user_id);
  const uid = eventTranslator.getUidByUin(userIdStr) || userIdStr;
  const rejectAdd = params.reject_add_request === true || params.reject_add === true;
  try {
    bridge.session.getGroupService().kickMember(groupIdStr, [uid], rejectAdd);
  } catch {}
  return {};
};

handlers.quit_group = async (params, bridge) => {
  if (!bridge.session) return {};
  try {
    bridge.session.getGroupService().quitGroup(toIdKey(params.group_id));
  } catch {}
  return {};
};

// ---- 戳一戳 API ----

handlers.send_group_nudge = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const userIdStr = toIdKey(params.user_id);
  let uid = eventTranslator.getUidByUin(userIdStr);
  if (!uid) {
    try {
      const r = await bridge.session.getProfileService().getUidByUin("FriendsServiceImpl", [userIdStr]);
      uid = r?.uidInfo?.get(userIdStr);
    } catch {}
  }
  if (!uid) uid = userIdStr;
  try {
    const groupService = bridge.session.getGroupService();
    if (typeof groupService.sendPoke === "function") {
      await groupService.sendPoke(toIdKey(params.group_id), uid);
    }
  } catch (e) {
    console.error("[milky-actions] send_group_nudge 出错:", e.message);
  }
  return {};
};

handlers.send_friend_nudge = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const userIdStr = toIdKey(params.user_id);
  const uid = eventTranslator.getUidByUin(userIdStr) || userIdStr;
  try {
    const msgService = bridge.session.getMsgService();
    if (typeof msgService.sendPoke === "function") {
      await msgService.sendPoke(uid);
    }
  } catch (e) {
    console.error("[milky-actions] send_friend_nudge 出错:", e.message);
  }
  return {};
};

// ---- 好友与加群请求处理 API ----

handlers.accept_friend_request = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const key = ensureStr(params.initiator_uid || params.request_id, "") || toIdKey(params.initiator_id);
  const rawId = eventTranslator._friendReqCache.get(key) || key;
  try {
    const buddyService = bridge.session.getBuddyService();
    if (typeof buddyService.approveOrRejectFriendRequest === "function") {
      await buddyService.approveOrRejectFriendRequest(rawId, true);
    } else if (typeof buddyService.handleFriendRequest === "function") {
      await buddyService.handleFriendRequest(rawId, true);
    }
  } catch (e) {
    console.error("[milky-actions] accept_friend_request 出错:", e.message);
  }
  return {};
};

handlers.reject_friend_request = async (params, bridge, eventTranslator) => {
  if (!bridge.session) return {};
  const key = ensureStr(params.initiator_uid || params.request_id, "") || toIdKey(params.initiator_id);
  const rawId = eventTranslator._friendReqCache.get(key) || key;
  try {
    const buddyService = bridge.session.getBuddyService();
    if (typeof buddyService.approveOrRejectFriendRequest === "function") {
      await buddyService.approveOrRejectFriendRequest(rawId, false);
    } else if (typeof buddyService.handleFriendRequest === "function") {
      await buddyService.handleFriendRequest(rawId, false);
    }
  } catch (e) {
    console.error("[milky-actions] reject_friend_request 出错:", e.message);
  }
  return {};
};

async function handleGroupRequestAction(params, bridge, eventTranslator, approve) {
  if (!bridge.session) return {};
  let seq = toIdKey(params.notification_seq);
  let groupCode = toIdKey(params.group_id);
  let typeNum = params.notification_type === "invited_join_request" ? 2 : 1;

  if (!seq && typeof params.request_id === "string") {
    const parts = params.request_id.split("|");
    seq = parts[0] || "";
    groupCode = parts[1] || "";
    typeNum = toIdNum(parts[2]) || 1;
  } else if (seq && eventTranslator._groupNotifyCache.has(seq)) {
    const cached = eventTranslator._groupNotifyCache.get(seq);
    if (!groupCode) groupCode = cached.groupCode;
    typeNum = cached.type || typeNum;
  }

  if (!seq || !groupCode) return {};
  const reason = approve ? "" : ensureStr(params.reason, "");
  const opCode = approve ? 1 : 2;
  try {
    const groupService = bridge.session.getGroupService();
    if (typeof groupService.operateGroupReqNotify === "function") {
      await groupService.operateGroupReqNotify(opCode, { groupCode, seq, type: typeNum }, reason);
    } else if (typeof groupService.operateGroupNotify === "function") {
      await groupService.operateGroupNotify(opCode, { groupCode, seq, type: typeNum }, reason);
    }
  } catch (e) {
    console.error("[milky-actions] 处理加群请求出错:", e.message);
  }
  return {};
}

handlers.accept_group_request = async (params, bridge, eventTranslator) => {
  return handleGroupRequestAction(params, bridge, eventTranslator, true);
};

handlers.reject_group_request = async (params, bridge, eventTranslator) => {
  return handleGroupRequestAction(params, bridge, eventTranslator, false);
};

// 保留旧动作名别名兼容
handlers.accept_group_join_request = handlers.accept_group_request;
handlers.reject_group_join_request = handlers.reject_group_request;

// ---- 其余标准接口占位实现 ----

handlers.get_forwarded_messages = async () => ({ messages: [] });
handlers.mark_message_as_read = async () => ({});
handlers.send_profile_like = async () => ({});
handlers.delete_friend = async () => ({});
handlers.get_friend_requests = async () => ({ requests: [] });
handlers.get_group_notifications = async () => ({ notifications: [], next_notification_seq: 0 });
handlers.set_avatar = async () => ({});
handlers.set_nickname = async () => ({});
handlers.set_bio = async () => ({});
handlers.get_cookies = async () => ({ cookies: "" });
handlers.get_csrf_token = async () => ({ csrf_token: "" });
handlers.set_group_avatar = async () => ({});
handlers.set_group_member_special_title = async () => ({});

module.exports = { handlers };
