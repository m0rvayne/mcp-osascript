#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SW = 1710, SH = 1112, MB = 25;
const usableH = SH - MB;
const halfW = Math.floor(SW / 2);
const halfH = Math.floor(usableH / 2);

const B = "\x1b[1m", G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";

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
  await sleep(1000);

  // === 1. Open Safari with multiple tabs ===
  print(`  ${Y}▸${X} open_app ${D}"Safari"${X}`);
  await tool("run_osascript", {
    script: `tell application "Safari"
  activate
  delay 1
  open location "https://github.com/m0rvayne"
  delay 0.5
  tell window 1 to make new tab with properties {URL:"https://github.com/m0rvayne/mcp-redteam"}
  delay 0.3
  tell window 1 to make new tab with properties {URL:"https://youtube.com"}
  delay 0.3
  tell window 1 to make new tab with properties {URL:"https://x.com"}
  delay 0.3
  tell window 1 to make new tab with properties {URL:"https://instagram.com"}
  delay 0.3
  tell window 1 to make new tab with properties {URL:"https://threads.net"}
  delay 0.3
  tell window 1 to make new tab with properties {URL:"https://github.com/m0rvayne/mcp-osascript"}
  delay 1
end tell`,
  });
  print(`  ${G}✓${X} Safari launched — 7 tabs opened`);
  await sleep(500);

  // === 2. Read browser tabs ===
  print("");
  print(`  ${Y}▸${X} get_browser_tabs ${D}browser: safari${X}`);
  const tabsRaw = await tool("get_browser_tabs", { browser: "safari" });
  const tabs = JSON.parse(tabsRaw);
  for (const t of tabs) {
    const title = t.title.length > 50 ? t.title.slice(0, 50) + "…" : t.title;
    print(`    ${title}${t.active ? ` ${G}★${X}` : ""}`);
  }
  await sleep(1000);

  // === 3. Window dance + Mail starts near the end ===
  print("");
  print(`  ${Y}▸${X} manage_windows ${D}— moving Safari around${X}`);
  await tool("run_osascript", {
    script: `tell application "System Events" to tell process "Safari"
  set size of window 1 to {${halfW}, ${halfH}}
  set position of window 1 to {0, ${MB}}
  delay 0.3
  set position of window 1 to {0, ${MB + halfH}}
  delay 0.3
  set position of window 1 to {${halfW}, ${MB + halfH}}
  delay 0.3
  set position of window 1 to {${halfW}, ${MB}}
  delay 0.3
  set position of window 1 to {0, ${MB}}
  delay 0.3
  set position of window 1 to {0, ${MB + halfH}}
  delay 0.3
  set position of window 1 to {${halfW}, ${MB + halfH}}
  delay 0.3
  set position of window 1 to {${halfW}, ${MB}}
  delay 0.3
  -- Park top-right quarter
  set position of window 1 to {${halfW}, ${MB}}
  set size of window 1 to {${halfW}, ${halfH}}
end tell`,
  });
  print(`  ${G}✓${X} Window positioned`);

  // === 4. Frontmost app + clipboard — fast ===
  print("");
  print(`  ${Y}▸${X} get_frontmost_app`);
  const appRaw = await tool("get_frontmost_app");
  const app = JSON.parse(appRaw);
  print(`  ${G}✓${X} ${app.name} (${app.bundleId})`);

  print(`  ${Y}▸${X} set_clipboard ${D}← active tab URL${X}`);
  const activeUrl = tabs.find((t) => t.active)?.url || "https://github.com/m0rvayne/mcp-osascript";
  await tool("set_clipboard", { content: activeUrl });
  print(`  ${G}✓${X} Copied: ${D}${activeUrl}${X}`);
  await sleep(500);

  // === 5. Mail — compose email with line-by-line typing ===
  print("");
  print(`  ${Y}▸${X} open_app ${D}"Mail"${X} + compose email`);
  await tool("run_osascript", {
    script: `tell application "Mail"
  activate
  delay 3
  set draftMessages to every outgoing message
  repeat with msg in draftMessages
    delete msg
  end repeat
  delay 0.3
  set msgContent to ""
  set newMsg to make new outgoing message with properties {visible:true, subject:"mcp-osascript — macOS automation for Claude", content:msgContent}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"hello@example.com"}
  end tell
  delay 0.8
  activate
  set msgContent to "Hi there!"
  set content of newMsg to msgContent
  delay 0.2
  set msgContent to msgContent & return & return & "Introducing mcp-osascript — the only macOS"
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & "MCP server with typed tools and security."
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & return & "What it can do:"
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & "- Move and resize windows across your screen"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Click any menu item in any application"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Read and write clipboard content"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Open URLs with scheme allowlist"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Type text and press keyboard shortcuts"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Read browser tabs from Safari and Chrome"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "- Show native macOS notifications"
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & return & "Install in 30 seconds: npx mcp-osascript"
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & return & "12 tools. 41 tests. MIT license."
  set content of newMsg to msgContent
  delay 0.18
  set msgContent to msgContent & return & "Built for developers who want AI"
  set content of newMsg to msgContent
  delay 0.14
  set msgContent to msgContent & return & "to actually do things on their Mac."
  set content of newMsg to msgContent
end tell`,
    timeout: 25,
  });
  print(`  ${G}✓${X} Email composed`);
  await sleep(1500);

  // === Done ===
  print("");
  print(`  ${G}${B}Done.${X} ${D}12 tools · 41 tests · npx mcp-osascript${X}`);
  print("");
  await sleep(2000);

  server.kill("SIGTERM");
  process.exit(0);
}

demo().catch((e) => {
  console.error("Error:", e.message);
  server.kill("SIGKILL");
  process.exit(1);
});
