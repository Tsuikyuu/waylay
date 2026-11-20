"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { handlers } = require("../src/milky/actions");
const { MilkyEventTranslator } = require("../src/milky/events");

function makeNtTextMsg(overrides) {
  return {
    msgId: "7700001",
    msgSeq: "101",
    chatType: 2,
    msgType: 2,
    senderUid: "u_alice",
    senderUin: "10001",
    peerUid: "721800134",
    peerUin: "721800134",
    peerName: "测试群",
    sendNickName: "Alice",
    sendMemberName: "群名片Alice",
    msgTime: "1795062000",
    recallTime: "0",
    elements: [
      {
        elementType: 1,
        elementId: "1",
        textElement: { content: "你好", atType: 0, atUid: "0", atNtUid: "" },
      },
    ],
    records: [],
    ...overrides,
  };
}

test("get_history_messages 复用已有 message_seq、过滤撤回与灰条，并支持分页与引用解析", async () => {
  const fullHistory = [
    makeNtTextMsg({ msgId: "7700001", msgSeq: "101", msgTime: "1795062001", senderUin: "10001" }),
    makeNtTextMsg({ msgId: "7700002", msgSeq: "102", msgTime: "1795062002", msgType: 5 }),
    makeNtTextMsg({ msgId: "7700003", msgSeq: "103", msgTime: "1795062003", recallTime: "1795062005" }),
    makeNtTextMsg({
      msgId: "7700004",
      msgSeq: "104",
      msgTime: "1795062004",
      senderUin: "487657862",
      senderUid: "u_bot",
      sendNickName: "小追求",
      sendMemberName: "小追求",
      elements: [
        {
          elementType: 1,
          elementId: "4",
          textElement: { content: "机器人发送的消息", atType: 0, atUid: "0", atNtUid: "" },
        },
      ],
    }),
    makeNtTextMsg({
      msgId: "7700005",
      msgSeq: "105",
      msgTime: "1795062005",
      msgType: 9,
      senderUin: "10002",
      senderUid: "u_bob",
      sendNickName: "Bob",
      sendMemberName: "Bob",
      elements: [
        {
          elementType: 7,
          elementId: "51",
          replyElement: {
            replayMsgId: "0",
            replayMsgSeq: "104",
            sourceMsgIdInRecords: "9900004",
          },
        },
        {
          elementType: 1,
          elementId: "52",
          textElement: { content: "回复机器人", atType: 0, atUid: "0", atNtUid: "" },
        },
      ],
    }),
  ];

  const bridge = {
    selfInfo: { uin: "487657862", uid: "u_bot", nickName: "小追求" },
    session: {
      getMsgService() {
        return {
          async getMsgsIncludeSelf(_peer, anchorMsgId, _cnt, queryOrder) {
            if (anchorMsgId === "0" && queryOrder === true) {
              return { result: 0, msgList: fullHistory };
            }
            const idx = fullHistory.findIndex((m) => m.msgId === anchorMsgId);
            return { result: 0, msgList: idx > 0 ? fullHistory.slice(0, idx) : [] };
          },
        };
      },
    },
  };

  const translator = new MilkyEventTranslator(bridge, (token) => `http://127.0.0.1:8082/media/${token}`);
  // 模拟发送时已为 7700004 预分配过 seq
  const preSeq = translator.createSeq("7700004");

  const page1 = await handlers.get_history_messages(
    { message_scene: "group", peer_id: 721800134, limit: 2 },
    bridge,
    translator
  );

  assert.strictEqual(page1.messages.length, 2);
  assert.strictEqual(page1.messages[0].message_seq, preSeq);
  assert.strictEqual(page1.messages[0].sender_id, 487657862);
  assert.strictEqual(page1.messages[1].segments[0].type, "reply");
  assert.strictEqual(page1.messages[1].segments[0].data.message_seq, preSeq);
  assert.ok(page1.next_message_seq > 0);

  // 通过 get_message 可直接取回被引用的机器人消息
  const quoted = await handlers.get_message({ message_seq: preSeq }, bridge, translator);
  assert.strictEqual(quoted.message.segments[0].data.text, "机器人发送的消息");

  // 使用 next_message_seq 继续向前翻页
  const page2 = await handlers.get_history_messages(
    { message_scene: "group", peer_id: 721800134, start_message_seq: page1.next_message_seq, limit: 2 },
    bridge,
    translator
  );
  assert.strictEqual(page2.messages.length, 1);
  assert.strictEqual(page2.messages[0].message_seq, page1.next_message_seq);
  assert.strictEqual(page2.messages[0].sender_id, 10001);
  assert.strictEqual(page2.next_message_seq, undefined);
});
