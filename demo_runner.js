#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Screen dimensions (1710x1112, menu bar 25px)
const SW = 1710, SH = 1112, MB = 25;
const usableH = SH - MB;
const halfW = Math.floor(SW / 2);
const halfH = Math.floor(usableH / 2);

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

  // === 1. Open Safari with GitHub repo ===
  print(`  ${Y}▸${X} open_app ${D}"Safari"${X}`);
  await tool("open_app", { name: "Safari" });
  print(`  ${G}✓${X} Safari launched`);
  await sleep(1500);

  print(`  ${Y}▸${X} open_url ${D}"https://github.com/m0rvayne/mcp-osascript"${X}`);
  await tool("run_osascript", {
    script: 'tell application "Safari" to set URL of front document to "https://github.com/m0rvayne/mcp-osascript"',
  });
  print(`  ${G}✓${X} Navigated to GitHub`);
  await sleep(3000);

  // === 2. Window dance — 2 loops around 4 quadrants ===
  print("");
  print(`  ${Y}▸${X} manage_windows ${D}— 2 loops around screen${X}`);

  const positions = [
    [0,     MB,          halfW, halfH],  // top-left
    [0,     MB + halfH,  halfW, halfH],  // bottom-left
    [halfW, MB + halfH,  halfW, halfH],  // bottom-right
    [halfW, MB,          halfW, halfH],  // top-right
  ];

  for (let loop = 0; loop < 2; loop++) {
    for (const [x, y, w, h] of positions) {
      await tool("run_osascript", {
        script: `tell application "System Events" to tell process "Safari"\n  set position of window 1 to {${x}, ${y}}\n  set size of window 1 to {${w}, ${h}}\nend tell`,
      });
      await sleep(500);
    }
  }

  // Park on right half
  await tool("run_osascript", {
    script: `tell application "System Events" to tell process "Safari"\n  set position of window 1 to {${halfW}, ${MB}}\n  set size of window 1 to {${halfW}, ${usableH}}\nend tell`,
  });
  print(`  ${G}✓${X} Window positioned`);
  await sleep(1500);

  // === 3. Notification ===
  print("");
  print(`  ${Y}▸${X} send_notification`);
  await tool("send_notification", {
    title: "Hello, Daniel!",
    message: "Yes, I can fully control your Mac. Windows, menus, keyboard, clipboard, browser — all through natural language.",
  });
  print(`  ${G}✓${X} Notification sent`);
  await sleep(3000);

  // === 4. Frontmost app ===
  print("");
  print(`  ${Y}▸${X} get_frontmost_app`);
  const appRaw = await tool("get_frontmost_app");
  const app = JSON.parse(appRaw);
  print(`  ${G}✓${X} ${app.name} (${app.bundleId})`);
  await sleep(1500);

  // === 5. Security ===
  print("");
  print(`  ${Y}▸${X} open_url ${D}"file:///etc/passwd"${X}`);
  print(`  ${R}✗${X} ${D}${await tool("open_url", { url: "file:///etc/passwd" })}${X}`);
  await sleep(1200);

  print(`  ${Y}▸${X} open_url ${D}"javascript:alert(1)"${X}`);
  print(`  ${R}✗${X} ${D}${await tool("open_url", { url: "javascript:alert(1)" })}${X}`);
  await sleep(2000);

  // === 6. Compose email via Mail API with line-by-line typing effect ===
  print("");
  print(`  ${Y}▸${X} open_app ${D}"Mail"${X} + compose email`);

  await tool("run_osascript", {
    script: `tell application "Mail"
  activate
  delay 2
  set msgContent to ""
  set newMsg to make new outgoing message with properties {visible:true, subject:"mcp-osascript — macOS automation for Claude", content:msgContent}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"hello@example.com"}
  end tell
  delay 1

  set msgContent to "Hi there!"
  set content of newMsg to msgContent
  delay 0.4
  set msgContent to msgContent & return & return
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & "Introducing mcp-osascript — the only macOS"
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & "MCP server with typed tools and security."
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & return & "What it can do:"
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & "- Move and resize windows across your screen"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Click any menu item in any application"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Read and write clipboard content"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Open URLs with scheme allowlist"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Type text and press keyboard shortcuts"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Read browser tabs from Safari and Chrome"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "- Show native macOS notifications"
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & return & "Install in 30 seconds: npx mcp-osascript"
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & return & "12 tools. 41 tests. MIT license."
  set content of newMsg to msgContent
  delay 0.35
  set msgContent to msgContent & return & "Built for developers who want AI"
  set content of newMsg to msgContent
  delay 0.3
  set msgContent to msgContent & return & "to actually do things on their Mac."
  set content of newMsg to msgContent
end tell`,
    timeout: 30,
  });
  print(`  ${G}✓${X} Email composed`);
  await sleep(2500);

  // === 7. Final ===
  print("");
  await tool("send_notification", {
    title: "Demo complete",
    message: "12 tools · 41 tests · MIT license · npx mcp-osascript",
  });
  print(`  ${G}${B}Done.${X} ${D}12 tools · 41 tests · npx mcp-osascript${X}`);
  print("");
  await sleep(3000);

  server.kill("SIGTERM");
  process.exit(0);
}

demo().catch((e) => {
  console.error("Error:", e.message);
  server.kill("SIGKILL");
  process.exit(1);
});
