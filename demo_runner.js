#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const B = "\x1b[1m", G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";

const server = spawn("node", [join(__dirname, "server/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LANG: "en_US.UTF-8" },
});

let msgId = 0;
const pending = new Map();
let buf = "";

server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line.trim());
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function send(method, params) {
  const isNotif = method.startsWith("notifications/");
  const id = isNotif ? undefined : ++msgId;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  if (isNotif) return new Promise((r) => setTimeout(r, 200));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 30000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}

async function tool(name, args = {}) {
  const r = await send("tools/call", { name, arguments: args });
  return r.result.content[0].text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const print = (t) => process.stdout.write(t + "\n");

async function demo() {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "demo", version: "1.0" } });
  await send("notifications/initialized", {});

  console.clear();
  print("");
  print(`${B}mcp-osascript${X} ${D}— demo${X}`);
  print("");
  await sleep(1500);

  // 1. Open Safari with a page
  print(`  ${Y}▸${X} open_app ${D}"Safari"${X}`);
  await sleep(400);
  print(`  ${G}✓${X} ${await tool("open_app", { name: "Safari" })}`);
  await sleep(1000);

  // 2. Open URL in Safari
  print(`  ${Y}▸${X} open_url ${D}"https://github.com"${X}`);
  await sleep(400);
  print(`  ${G}✓${X} ${await tool("open_url", { url: "https://github.com" })}`);
  await sleep(2500);

  // 3. Read browser tabs
  print("");
  print(`  ${Y}▸${X} get_browser_tabs ${D}browser: safari${X}`);
  await sleep(400);
  const tabsRaw = await tool("get_browser_tabs", { browser: "safari" });
  const tabs = JSON.parse(tabsRaw);
  for (const t of tabs.slice(0, 4)) {
    const title = t.title.length > 50 ? t.title.slice(0, 50) + "…" : t.title;
    print(`    ${title}${t.active ? ` ${G}★${X}` : ""}`);
  }
  if (tabs.length > 4) print(`    ${D}… and ${tabs.length - 4} more${X}`);
  await sleep(2000);

  // 4. Clipboard: copy active tab URL
  print("");
  const activeUrl = tabs.find((t) => t.active)?.url || "https://github.com";
  print(`  ${Y}▸${X} set_clipboard ${D}← active tab URL${X}`);
  await sleep(400);
  await tool("set_clipboard", { content: activeUrl });
  print(`  ${G}✓${X} Copied: ${D}${activeUrl}${X}`);
  await sleep(1500);

  print(`  ${Y}▸${X} get_clipboard`);
  await sleep(400);
  print(`  ${G}✓${X} ${await tool("get_clipboard")}`);
  await sleep(1500);

  // 5. Notification
  print("");
  print(`  ${Y}▸${X} send_notification`);
  await sleep(400);
  await tool("send_notification", { title: "mcp-osascript", message: "Yes, I can control your Mac!" });
  print(`  ${G}✓${X} Notification sent`);
  await sleep(2500);

  // 6. Frontmost app
  print("");
  print(`  ${Y}▸${X} get_frontmost_app`);
  await sleep(400);
  const appRaw = await tool("get_frontmost_app");
  const app = JSON.parse(appRaw);
  print(`  ${G}✓${X} ${app.name} (${app.bundleId})`);
  await sleep(1500);

  // 7. Run JXA
  print("");
  print(`  ${Y}▸${X} run_osascript ${D}language: javascript${X}`);
  await sleep(400);
  const jxa = await tool("run_osascript", {
    script: "var d = new Date(); d.toLocaleDateString() + ' ' + d.toLocaleTimeString()",
    language: "javascript",
  });
  print(`  ${G}✓${X} JXA → ${jxa}`);
  await sleep(1500);

  // 8. Security
  print("");
  print(`  ${Y}▸${X} open_url ${D}"file:///etc/passwd"${X}`);
  await sleep(400);
  print(`  ${R}✗${X} ${D}${await tool("open_url", { url: "file:///etc/passwd" })}${X}`);
  await sleep(1200);

  print(`  ${Y}▸${X} open_url ${D}"javascript:alert(1)"${X}`);
  await sleep(400);
  print(`  ${R}✗${X} ${D}${await tool("open_url", { url: "javascript:alert(1)" })}${X}`);
  await sleep(2000);

  // Done
  print("");
  await tool("send_notification", { title: "Demo complete", message: "12 tools · 41 tests · MIT" });
  print(`  ${G}${B}Done.${X} ${D}12 tools · 41 tests · npx mcp-osascript${X}`);
  print("");
  await sleep(3000);

  server.kill("SIGTERM");
  process.exit(0);
}

demo().catch((e) => { console.error("Error:", e.message); server.kill("SIGKILL"); process.exit(1); });
