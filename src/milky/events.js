"use strict";

const { ntToMilky } = require("./message");
const { toIdNum, toIdKey, ensureStr } = require("./id");

/**
 * 将 NTQQ 内核监听器事件转换为符合 Milky 协议标准的事件对象
 *
 * Milky 事件信封格式：{ time, self_id, event_type, data }
 */
class MilkyEventTranslator {
  constructor(bridge, mediaUrlBuilder) {
    this.bridge = bridge;
    this.mediaUrlBuilder = typeof mediaUrlBuilder === "function" ? mediaUrlBuilder : null;
    // 消息序列号计数器：以纪元偏移初始化为 31 位正整数，避免容器重启后与客户端持久化历史碰撞
    const epochOffset = Math.floor((Date.now() - 1760000000000) / 250);
    this._seqCounter = epochOffset > 1000 ? (epochOffset & 0x3fffffff) : 1000;
    this._msgIdToSeq = new Map(); // NTQQ msgId -> seq (number)
    this._seqToMsgId = new Map(); // seq (number) -> NTQQ msgId
    this._ntSeqToSeq = new Map(); // "${chatType}:${peerKey}:${ntMsgSeq}" -> seq (number)
    this._msgCache = new Map(); // seq -> Milky IncomingMessage
    this._msgNtMeta = new Map(); // seq -> { ntMsgSeq, senderUinStr }

    // UIN <-> UID 双向映射
    this._uinToUid = new Map();
    this._uidToUin = new Map();

    // 群成员缓存：groupCodeStr -> Map<uinStr, { uid, nick, card, role }>
    this._groupMembers = new Map();
    // 群列表缓存：groupCodeStr -> NTQQ group info
    this._groupList = new Map();
    // 好友列表缓存：uinStr -> { uid, nick, remark, categoryId, categoryName }
    this._buddyList = new Map();

    // 待处理请求缓存
    this._groupNotifyCache = new Map(); // seqStr -> { groupCode, seq, type }
    this._friendReqCache = new Map(); // initiatorUidOrUin -> rawId
  }

  get selfId() {
    return toIdNum(this.bridge.selfInfo.uin);
  }

  createSeq(msgId) {
    const key = ensureStr(msgId, "");
    const validKey = key !== "" && key !== "0" ? key : "";
    if (validKey !== "" && this._msgIdToSeq.has(validKey)) {
      return this._msgIdToSeq.get(validKey);
    }
    this._seqCounter++;
    const seq = this._seqCounter;
    if (validKey !== "") {
      this._msgIdToSeq.set(validKey, seq);
      this._seqToMsgId.set(seq, validKey);
    }
    return seq;
  }

  resolveSeq(seq) {
    return this._seqToMsgId.get(toIdNum(seq));
  }

  cacheMsg(seq, incomingMessage, ntMeta) {
    this._msgCache.set(seq, incomingMessage);
    if (ntMeta) {
      this._msgNtMeta.set(seq, ntMeta);
    }
    if (this._msgCache.size > 5000) {
      const oldest = this._msgCache.keys().next().value;
      this._msgCache.delete(oldest);
      this._msgNtMeta.delete(oldest);
    }
  }

  getCachedMsg(seq) {
    return this._msgCache.get(toIdNum(seq));
  }

  getCachedNtMeta(seq) {
    return this._msgNtMeta.get(toIdNum(seq));
  }

  // 记录会话内原生消息序号（msgSeq）到 Milky message_seq 的映射，用于关联引用回复
  recordNtSeq(chatType, peerKey, ntMsgSeq, seq) {
    const keyPeer = ensureStr(peerKey, "");
    const keyNtSeq = ensureStr(ntMsgSeq, "");
    const seqNum = toIdNum(seq);
    if (!chatType || keyPeer === "" || keyPeer === "0" || keyNtSeq === "" || keyNtSeq === "0" || seqNum <= 0) {
      return;
    }
    const composite = `${chatType}:${keyPeer}:${keyNtSeq}`;
    this._ntSeqToSeq.set(composite, seqNum);
    if (this._ntSeqToSeq.size > 5000) {
      const oldest = this._ntSeqToSeq.keys().next().value;
      this._ntSeqToSeq.delete(oldest);
    }
  }

  resolveNtSeq(chatType, peerKey, ntMsgSeq) {
    const keyPeer = ensureStr(peerKey, "");
    const keyNtSeq = ensureStr(ntMsgSeq, "");
    if (!chatType || keyPeer === "" || keyPeer === "0" || keyNtSeq === "" || keyNtSeq === "0") {
      return 0;
    }
    return this._ntSeqToSeq.get(`${chatType}:${keyPeer}:${keyNtSeq}`) || 0;
  }

  // 按会话场景与对端 ID 从内存缓存筛选历史消息（按 message_seq 升序）
  getCachedHistory(scene, peerIdNum, startSeq) {
    const matched = [];
    const upperSeq = toIdNum(startSeq);
    for (const [seq, item] of this._msgCache.entries()) {
      if (!item || item.message_scene !== scene || item.peer_id !== peerIdNum) continue;
      if (upperSeq > 0 && seq > upperSeq) continue;
      matched.push(item);
    }
    matched.sort((a, b) => a.message_seq - b.message_seq);
    return matched;
  }

  recordUinUid(uin, uid) {
    const uinStr = toIdKey(uin);
    if (uinStr && typeof uid === "string" && uid.startsWith("u_")) {
      this._uinToUid.set(uinStr, uid);
      this._uidToUin.set(uid, uinStr);
    }
  }

  getUidByUin(uin) {
    return this._uinToUid.get(toIdKey(uin));
  }

  getUinByUid(uid) {
    return this._uidToUin.get(uid);
  }

  recordGroupMember(groupId, uin, uid, nick, card, roleCode) {
    const gid = toIdKey(groupId);
    const uinStr = toIdKey(uin);
    if (!gid || !uinStr) return;
    if (!this._groupMembers.has(gid)) {
      this._groupMembers.set(gid, new Map());
    }
    const existing = this._groupMembers.get(gid).get(uinStr) || {};
    let role = existing.role || "member";
    if (roleCode === 4) role = "owner";
    else if (roleCode === 3) role = "admin";
    else if (roleCode === 2) role = "member";

    this._groupMembers.get(gid).set(uinStr, {
      uid: uid || existing.uid || "",
      nick: nick || existing.nick || "",
      card: card || existing.card || "",
      role,
    });
  }

  getGroupMember(groupId, uin) {
    return this._groupMembers.get(toIdKey(groupId))?.get(toIdKey(uin));
  }

  getGroupList() {
    return Array.from(this._groupList.values());
  }

  getBuddyList() {
    return this._buddyList;
  }

  // 构造标准 Milky FriendEntity
  buildFriendEntity(uin, fallbackNick) {
    const uinStr = toIdKey(uin);
    const b = this._buddyList.get(uinStr);
    return {
      user_id: toIdNum(uinStr),
      nickname: (b && b.nick) || ensureStr(fallbackNick, ""),
      sex: "unknown",
      qid: "",
      remark: (b && b.remark) || "",
      category: {
        category_id: (b && b.categoryId) || 0,
        category_name: (b && b.categoryName) || "默认分组",
      },
    };
  }

  // 构造标准 Milky GroupEntity
  buildGroupEntity(groupId, fallbackName) {
    const gidStr = toIdKey(groupId);
    const g = this._groupList.get(gidStr);
    return {
      group_id: toIdNum(gidStr),
      group_name: (g && g.groupName) || ensureStr(fallbackName, ""),
      member_count: g ? toIdNum(g.memberCount) : 0,
      max_member_count: g ? toIdNum(g.maxMember) : 0,
    };
  }

  // 构造标准 Milky GroupMemberEntity
  buildGroupMemberEntity(groupId, uin, fallbackNick, fallbackCard, lastSentTime) {
    const gidStr = toIdKey(groupId);
    const uinStr = toIdKey(uin);
    const m = this.getGroupMember(gidStr, uinStr);
    return {
      group_id: toIdNum(gidStr),
      user_id: toIdNum(uinStr),
      nickname: ensureStr(fallbackNick, "") || (m && m.nick) || "",
      card: ensureStr(fallbackCard, "") || (m && m.card) || "",
      title: "",
      sex: "unknown",
      level: 0,
      role: (m && m.role) || "member",
      join_time: 0,
      last_sent_time: typeof lastSentTime === "number" ? lastSentTime : 0,
    };
  }

  _makeEvent(eventType, data) {
    return {
      time: Math.floor(Date.now() / 1000),
      self_id: this.selfId,
      event_type: eventType,
      data,
    };
  }

  translate(listenerName, eventName, data) {
    try {
      if (listenerName === "nodeIKernelMsgListener") {
        return this._translateMsgEvent(eventName, data);
      }
      if (listenerName === "nodeIKernelGroupListener") {
        return this._translateGroupEvent(eventName, data);
      }
      if (listenerName === "nodeIKernelBuddyListener") {
        return this._translateBuddyEvent(eventName, data);
      }
      return [];
    } catch (e) {
      console.error(`[milky-events] 转换事件 ${listenerName}.${eventName} 出错:`, e.message);
      return [];
    }
  }

  // ---- 消息事件转换 ----

  _translateMsgEvent(eventName, data) {
    if (eventName === "onRecvMsg" || eventName === "onRecvActiveMsg") {
      return this._onRecvMsg(data);
    }
    if (eventName === "onAddSendMsg") {
      this._onAddSendMsg(data);
      return [];
    }
    if (eventName === "onMsgInfoListUpdate") {
      return this._onMsgInfoListUpdate(data);
    }
    return [];
  }

  _onAddSendMsg(data) {
    const msg = Array.isArray(data) ? data[0] : data;
    if (!msg || !msg.msgId || msg.msgId === "0") return;
    this.toIncomingMessage(msg);
  }

  // 将单条 NTQQ 消息对象转换为 Milky IncomingMessage 并写入缓存；灰条或已撤回消息返回 null
  toIncomingMessage(msg, options) {
    if (!msg || !msg.msgId || msg.msgId === "0") return null;
    const isRecordCopy = options && options.isRecordCopy === true;
    const fallbackPeerId = options && options.fallbackPeerId ? options.fallbackPeerId : "";

    const recallStr = ensureStr(msg.recallTime, "0");
    if (recallStr !== "" && recallStr !== "0") return null;

    if (msg.senderUin && msg.senderUid) {
      this.recordUinUid(msg.senderUin, msg.senderUid);
    }
    const groupPeerRaw = toIdNum(msg.peerUin) > 0 ? msg.peerUin : (msg.chatType === 2 ? msg.peerUid : "");
    if (msg.chatType === 2 && msg.senderUin && groupPeerRaw) {
      this.recordGroupMember(
        groupPeerRaw,
        msg.senderUin,
        msg.senderUid,
        msg.sendNickName,
        msg.senderMemberName || msg.sendMemberName,
        msg.sendMemberRole
      );
    }
    if (msg.chatType === 1 && msg.peerUid && msg.peerUin) {
      this.recordUinUid(msg.peerUin, msg.peerUid);
    }

    if (msg.msgType === 5) return null;

    let resolvedSenderUin = toIdKey(msg.senderUin);
    if ((!resolvedSenderUin || resolvedSenderUin === "0") && msg.senderUid) {
      const mappedSender = this.getUinByUid(msg.senderUid);
      if (mappedSender) {
        resolvedSenderUin = mappedSender;
      } else if (this.bridge.selfInfo.uid && msg.senderUid === this.bridge.selfInfo.uid) {
        resolvedSenderUin = toIdKey(this.bridge.selfInfo.uin);
      }
    }

    let peerKey = "";
    if (msg.chatType === 2) {
      peerKey = toIdKey(groupPeerRaw || fallbackPeerId);
    } else if (msg.chatType === 1 || msg.chatType === 100) {
      const candidatePeer = toIdNum(msg.peerUin) > 0
        ? msg.peerUin
        : (this.getUinByUid(msg.peerUid) || fallbackPeerId || resolvedSenderUin);
      peerKey = toIdKey(candidatePeer);
    }

    // 先确保内嵌引用副本（msg.records）可被解析为稳定的 message_seq
    if (!isRecordCopy && Array.isArray(msg.records)) {
      for (let r = 0; r < msg.records.length; r++) {
        const rec = msg.records[r];
        if (!rec || !rec.msgId) continue;
        const recNtSeq = ensureStr(rec.msgSeq, "0");
        if (this.resolveNtSeq(rec.chatType || msg.chatType, peerKey, recNtSeq) <= 0) {
          this.toIncomingMessage(rec, { isRecordCopy: true, fallbackPeerId: peerKey });
        }
      }
    }

    const ntMsgSeq = ensureStr(msg.msgSeq, "0");
    const msgIdStr = ensureStr(msg.msgId, "");
    let seq = 0;
    if (msgIdStr !== "" && msgIdStr !== "0" && this._msgIdToSeq.has(msgIdStr)) {
      seq = this._msgIdToSeq.get(msgIdStr);
    } else {
      const byNtSeq = this.resolveNtSeq(msg.chatType, peerKey, ntMsgSeq);
      if (byNtSeq > 0) {
        seq = byNtSeq;
        if (msgIdStr !== "" && msgIdStr !== "0" && !isRecordCopy) {
          this._msgIdToSeq.set(msgIdStr, seq);
          this._seqToMsgId.set(seq, msgIdStr);
        }
      } else {
        seq = this.createSeq(isRecordCopy ? "" : msgIdStr);
        if (isRecordCopy && msgIdStr !== "" && msgIdStr !== "0") {
          this._msgIdToSeq.set(msgIdStr, seq);
        }
      }
    }
    this.recordNtSeq(msg.chatType, peerKey, ntMsgSeq, seq);

    const segments = ntToMilky(msg.elements, msg, (uid) => this.getUinByUid(uid), this.mediaUrlBuilder);

    // 回填引用回复段的 message_seq（优先匹配真实 msgId，其次匹配会话内 replayMsgSeq）
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      if (seg.type === "reply") {
        const replyEl = msg.elements?.find((e) => e.replyElement)?.replyElement;
        if (replyEl) {
          const directRefId = ensureStr(replyEl.replayMsgId, "");
          const recordRefId = ensureStr(replyEl.sourceMsgIdInRecords, "");
          const replyNtSeq = ensureStr(replyEl.replayMsgSeq, "0");
          let refSeq = 0;
          if (directRefId !== "" && directRefId !== "0" && this._msgIdToSeq.has(directRefId)) {
            refSeq = this._msgIdToSeq.get(directRefId);
          } else {
            refSeq = this.resolveNtSeq(msg.chatType, peerKey, replyNtSeq);
            if (refSeq <= 0 && recordRefId !== "" && recordRefId !== "0" && this._msgIdToSeq.has(recordRefId)) {
              refSeq = this._msgIdToSeq.get(recordRefId);
            }
          }
          if (refSeq > 0) {
            seg.data.message_seq = refSeq;
          }
        }
      }
    }

    const msgTime = toIdNum(msg.msgTime) || Math.floor(Date.now() / 1000);
    const senderId = toIdNum(resolvedSenderUin);

    let incoming = null;
    if (segments.length > 0) {
      if (msg.chatType === 2) {
        const groupIdNum = toIdNum(peerKey);
        incoming = {
          message_scene: "group",
          peer_id: groupIdNum,
          message_seq: seq,
          sender_id: senderId,
          time: msgTime,
          segments,
          group: this.buildGroupEntity(peerKey, msg.peerName),
          group_member: this.buildGroupMemberEntity(
            peerKey,
            resolvedSenderUin,
            msg.sendNickName,
            msg.senderMemberName || msg.sendMemberName,
            msgTime
          ),
        };
      } else if (msg.chatType === 1) {
        incoming = {
          message_scene: "friend",
          peer_id: toIdNum(peerKey),
          message_seq: seq,
          sender_id: senderId,
          time: msgTime,
          segments,
          friend: this.buildFriendEntity(peerKey, msg.sendNickName),
        };
      } else if (msg.chatType === 100) {
        incoming = {
          message_scene: "temp",
          peer_id: toIdNum(peerKey),
          message_seq: seq,
          sender_id: senderId,
          time: msgTime,
          segments,
        };
      }
    }

    const meta = {
      ntMsgSeq,
      senderUinStr: resolvedSenderUin || "0",
    };
    if (incoming) {
      this.cacheMsg(seq, incoming, meta);
    } else {
      this._msgNtMeta.set(seq, meta);
    }
    return incoming;
  }

  _onRecvMsg(data) {
    const events = [];
    const msgList = Array.isArray(data) ? data : data?.msgList || [data];

    for (let idx = 0; idx < msgList.length; idx++) {
      const msg = msgList[idx];
      if (!msg || !msg.msgId) continue;

      // 灰条提示消息单独转换为群管/戳一戳通知事件
      if (msg.msgType === 5) {
        if (msg.senderUin && msg.senderUid) {
          this.recordUinUid(msg.senderUin, msg.senderUid);
        }
        events.push(...this._handleGrayTip(msg));
        continue;
      }

      const eventData = this.toIncomingMessage(msg);
      if (eventData) {
        events.push(this._makeEvent("message_receive", eventData));
      }

      const senderId = toIdNum(msg.senderUin);

      // 群文件上传附加事件
      if (msg.chatType === 2) {
        for (const el of msg.elements || []) {
          if (el.fileElement) {
            events.push(this._makeEvent("group_file_upload", {
              group_id: toIdNum(msg.peerUin),
              user_id: senderId,
              file_id: el.fileElement.fileUuid || "",
              file_name: el.fileElement.fileName || "",
              file_size: toIdNum(el.fileElement.fileSize),
            }));
          }
        }
      }

      // 私聊文件上传附加事件
      if (msg.chatType === 1) {
        for (const el of msg.elements || []) {
          if (el.fileElement) {
            events.push(this._makeEvent("friend_file_upload", {
              user_id: senderId,
              file_id: el.fileElement.fileUuid || "",
              file_name: el.fileElement.fileName || "",
              file_size: toIdNum(el.fileElement.fileSize),
              file_hash: el.fileElement.fileMd5 || "",
              is_self: senderId === this.selfId,
            }));
          }
        }
      }
    }
    return events;
  }

  _onMsgInfoListUpdate(data) {
    const events = [];
    const msgList = Array.isArray(data) ? data : data?.msgList || [data];

    for (let i = 0; i < msgList.length; i++) {
      const msg = msgList[i];
      if (!msg) continue;
      if (!msg.recallTime || msg.recallTime === "0") {
        // 发送消息落定后内核会回推正式 msgSeq，同步更新序号映射与消息缓存
        if (msg.msgId && msg.msgId !== "0" && msg.msgSeq && msg.msgSeq !== "0") {
          this.toIncomingMessage(msg);
        }
        continue;
      }

      const seq = this._msgIdToSeq.get(ensureStr(msg.msgId, "")) || 0;
      if (seq > 0) {
        this._msgCache.delete(seq);
      }
      const senderId = toIdNum(msg.senderUin);
      if (msg.chatType === 2) {
        events.push(this._makeEvent("message_recall", {
          message_scene: "group",
          peer_id: toIdNum(msg.peerUin),
          message_seq: seq,
          sender_id: senderId,
          operator_id: senderId,
          display_suffix: "",
        }));
      } else if (msg.chatType === 1) {
        events.push(this._makeEvent("message_recall", {
          message_scene: "friend",
          peer_id: toIdNum(msg.peerUin || msg.senderUin),
          message_seq: seq,
          sender_id: senderId,
          operator_id: senderId,
          display_suffix: "",
        }));
      }
    }
    return events;
  }

  _handleGrayTip(msg) {
    const events = [];
    if (!msg.elements) return events;

    for (let i = 0; i < msg.elements.length; i++) {
      const el = msg.elements[i];
      if (!el.grayTipElement) continue;
      const tip = el.grayTipElement;

      if (tip.subElementType === 4 && tip.groupElement) {
        const ge = tip.groupElement;
        const groupId = toIdNum(msg.peerUin);

        if (ge.type === 1) {
          events.push(this._makeEvent("group_member_increase", {
            group_id: groupId,
            user_id: toIdNum(ge.memberUin),
            operator_id: toIdNum(ge.adminUin),
            invitor_id: 0,
          }));
        }

        if (ge.type === 3) {
          events.push(this._makeEvent("group_member_decrease", {
            group_id: groupId,
            user_id: toIdNum(ge.memberUin),
            operator_id: toIdNum(ge.adminUin),
          }));
        }

        if (ge.type === 8) {
          const duration = toIdNum(ge.shutUp?.duration);
          events.push(this._makeEvent("group_mute", {
            group_id: groupId,
            user_id: toIdNum(ge.memberUin || ge.shutUp?.member?.uin),
            operator_id: toIdNum(ge.adminUin || ge.shutUp?.admin?.uin),
            duration,
          }));
        }

        if (ge.type === 5 || ge.type === 13) {
          events.push(this._makeEvent("group_admin_change", {
            group_id: groupId,
            user_id: toIdNum(ge.memberUin),
            operator_id: toIdNum(ge.adminUin),
            is_set: ge.type === 5,
          }));
        }
      }

      // JSON 灰条（戳一戳通知）
      if (tip.subElementType === 17 && tip.jsonGrayTipElement) {
        const json = tip.jsonGrayTipElement;
        const busiId = toIdKey(json.busiId);

        if (busiId === "1061") {
          try {
            const parsed = JSON.parse(json.jsonStr);
            const items = Array.isArray(parsed) ? parsed : (parsed?.items || []);
            const uinNodes = items.filter((it) => it && (it.uin || it.uid));
            const resolveNodeUin = (node) => {
              if (!node) return 0;
              if (node.uin) return toIdNum(node.uin);
              if (node.uid) {
                const mapped = this.getUinByUid(node.uid);
                return mapped ? toIdNum(mapped) : toIdNum(node.uid);
              }
              return 0;
            };
            const senderId = resolveNodeUin(uinNodes[0]);
            const receiverId = uinNodes[1] ? resolveNodeUin(uinNodes[1]) : this.selfId;

            if (senderId) {
              if (msg.chatType === 2) {
                events.push(this._makeEvent("group_nudge", {
                  group_id: toIdNum(msg.peerUin),
                  sender_id: senderId,
                  receiver_id: receiverId,
                  display_action: "戳了戳",
                  display_suffix: "",
                  display_action_img_url: "",
                }));
              } else {
                const otherId = senderId === this.selfId ? receiverId : senderId;
                events.push(this._makeEvent("friend_nudge", {
                  user_id: otherId,
                  is_self_send: senderId === this.selfId,
                  is_self_receive: receiverId === this.selfId,
                  display_action: "戳了戳",
                  display_suffix: "",
                  display_action_img_url: "",
                }));
              }
            }
          } catch {}
        }
      }
    }
    return events;
  }

  // ---- 群组事件转换 ----

  _translateGroupEvent(eventName, data) {
    if (eventName === "onGroupNotifyChange") {
      return this._onGroupNotifyChange(data);
    }
    if (eventName === "onGroupListUpdate") {
      this._cacheGroupList(data);
    }
    if (eventName === "onMemberInfoChange" || eventName === "onMemberListChange") {
      this._cacheMemberInfo(data);
    }
    return [];
  }

  _cacheGroupList(data) {
    const groups = Array.isArray(data) ? data[1] : data?.groupList || [];
    if (!Array.isArray(groups)) return;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g?.groupCode) {
        this._groupList.set(toIdKey(g.groupCode), g);
      }
    }
  }

  _cacheMemberInfo(data) {
    const groupCode = data?.groupCode || (Array.isArray(data) ? data[0] : null);
    if (!groupCode) return;
    const infos = data?.infos || (Array.isArray(data) ? data[2] : null);
    if (!infos) return;
    try {
      const iter = typeof infos.entries === "function" ? infos.entries() : Object.entries(infos);
      for (const [uid, m] of iter) {
        if (m?.uin) {
          this.recordUinUid(m.uin, uid);
          this.recordGroupMember(groupCode, m.uin, uid, m.nick, m.cardName, m.role);
        }
      }
    } catch {}
  }

  _onGroupNotifyChange(data) {
    const events = [];
    const notifies = Array.isArray(data) ? data : data?.notifies || [data];

    for (let i = 0; i < notifies.length; i++) {
      const notify = notifies[i];
      if (!notify || notify.status !== 0) continue;
      const groupCodeStr = toIdKey(notify.group?.groupCode || notify.groupCode || "0");
      const groupId = toIdNum(groupCodeStr);
      const requesterUin = toIdNum(notify.user1?.uin || notify.requestorUin);
      const inviterUin = toIdNum(notify.user2?.uin || notify.invitorUin);
      const comment = notify.postscript || "";
      const seqStr = toIdKey(notify.seq || "0");
      const seqNum = toIdNum(seqStr);

      if (seqStr) {
        this._groupNotifyCache.set(seqStr, {
          groupCode: groupCodeStr,
          seq: seqStr,
          type: toIdNum(notify.type) || 1,
        });
      }

      if (notify.type === 1) {
        events.push(this._makeEvent("group_join_request", {
          group_id: groupId,
          notification_seq: seqNum,
          is_filtered: false,
          initiator_id: requesterUin,
          comment,
        }));
      } else if (notify.type === 2 || notify.type === 13) {
        events.push(this._makeEvent("group_invited_join_request", {
          group_id: groupId,
          notification_seq: seqNum,
          initiator_id: inviterUin,
          target_user_id: requesterUin,
        }));
      }
    }
    return events;
  }

  // ---- 好友事件转换 ----

  _translateBuddyEvent(eventName, data) {
    if (eventName === "onBuddyListChange") {
      const categories = Array.isArray(data) ? data : [];
      for (let c = 0; c < categories.length; c++) {
        const cat = categories[c];
        const catId = toIdNum(cat?.categoryId);
        const catName = cat?.categroyName || cat?.categoryName || "默认分组";
        for (const buddy of cat?.buddyList || []) {
          if (buddy.uin && buddy.uid) {
            this.recordUinUid(buddy.uin, buddy.uid);
          }
          if (buddy.uin) {
            this._buddyList.set(toIdKey(buddy.uin), {
              uid: buddy.uid || "",
              nick: buddy.nick || "",
              remark: buddy.remark || "",
              categoryId: catId,
              categoryName: catName,
            });
          }
        }
      }
      return [];
    }

    if (eventName === "onBuddyReqChange") {
      const events = [];
      const reqs = data?.buddyReqs || data?.unreadNums ? [] : (Array.isArray(data) ? data : [data]);
      for (let i = 0; i < reqs.length; i++) {
        const req = reqs[i];
        if (!req?.friendUin && !req?.friendUid) continue;
        const uinNum = toIdNum(req.friendUin);
        const uidStr = ensureStr(req.friendUid || req.friendUin, "");
        if (uidStr) {
          this._friendReqCache.set(uidStr, ensureStr(req.friendUid || req.friendUin, ""));
        }
        if (uinNum) {
          this._friendReqCache.set(toIdKey(uinNum), ensureStr(req.friendUid || req.friendUin, ""));
        }
        events.push(this._makeEvent("friend_request", {
          initiator_id: uinNum,
          initiator_uid: uidStr,
          comment: req.extMsg || "",
          via: req.source || "",
        }));
      }
      return events;
    }
    return [];
  }
}

module.exports = { MilkyEventTranslator };
