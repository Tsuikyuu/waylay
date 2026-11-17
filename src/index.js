"use strict";

const { Bridge } = require("./bridge");
const { BridgeServer } = require("./server");
const { MilkyAdapter } = require("./milky/adapter");
const { VERSION } = require("./version");

// --- Parse CLI arguments and environment ---

function parseConfig() {
  const config = {
    port: parseInt(process.env.BRIDGE_PORT || "13000"),
    host: process.env.BRIDGE_HOST || "0.0.0.0",
    quickLoginQQ: process.env.AUTO_LOGIN_QQ || "",
    // Auto re-login after being kicked offline (default on; set AUTO_RELOGIN=false to disable,
    // e.g. if it causes a tug-of-war with another PC-slot login).
    autoRelogin: process.env.AUTO_RELOGIN !== "false",
    qqResourceAppDir: process.env.QQ_APP_DIR || "/opt/QQ/resources/app",

    // Milky 协议配置
    milkyPort: parseInt(process.env.MILKY_HTTP_PORT || "0"),
    milkyHost: process.env.MILKY_HOST || "0.0.0.0",
    milkyToken: process.env.MILKY_TOKEN || "",
    milkyPublicUrl: process.env.MILKY_PUBLIC_URL || "",
    milkyWebhookUrls: parseJsonArray(process.env.MILKY_WEBHOOK_URLS || ""),
  };

  for (const arg of process.argv) {
    if (arg.startsWith("--port=")) config.port = parseInt(arg.split("=")[1]);
    if (arg.startsWith("--host=")) config.host = arg.split("=")[1];
    if (arg.startsWith("--qq-app-dir=")) config.qqResourceAppDir = arg.split("=")[1];
    if (arg.startsWith("--quick-login=")) config.quickLoginQQ = arg.split("=")[1];
    if (arg.startsWith("--milky-port=")) config.milkyPort = parseInt(arg.split("=")[1]);
    if (arg.startsWith("--milky-token=")) config.milkyToken = arg.split("=")[1];
    if (arg.startsWith("--milky-webhook=")) {
      config.milkyWebhookUrls = parseJsonArray(arg.split("=").slice(1).join("="));
    }
  }

  return config;
}

function parseJsonArray(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return str.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

module.exports = { parseConfig };

async function main() {
  const config = parseConfig();

  console.log(`=== waylay v${VERSION} ===`);
  console.log(`[main] Config:`, JSON.stringify(config, null, 2));

  const bridge = new Bridge(config);

  // 桥接服务
  const server = new BridgeServer(config.port, config.host, bridge);
  bridge.setServer(server);

  // Milky 协议适配器（始终挂载以便控制台状态统计与 API 调试使用，配置端口后启动监听）
  const milkyAdapter = new MilkyAdapter(
    {
      port: config.milkyPort,
      host: config.milkyHost,
      token: config.milkyToken,
      publicUrl: config.milkyPublicUrl,
      webhookUrls: config.milkyWebhookUrls,
    },
    bridge
  );
  bridge.setMilkyAdapter(milkyAdapter);

  // 启动服务
  await server.start();
  if (config.milkyPort) await milkyAdapter.start();

  // Then initialize NTQQ
  await bridge.init();

  console.log("[main] Bridge is running. Waiting for QQ login...");
}

main().catch((e) => {
  console.error("[main] Fatal error:", e);
  process.exit(1);
});
