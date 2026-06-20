import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
let msgId = 0;
let passed = 0;
let failed = 0;

const TEST_TIMEOUT_MS = 10_000;

// Launch server
const server = spawn("node", [join(__dirname, "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LANG: "en_US.UTF-8" },
});

server.stderr.on("data", (chunk) => {
  // Suppress stderr unless debugging
  if (process.env.DEBUG) {
    process.stderr.write(chunk);
  }
});

// Pending response resolvers keyed by message id
const pending = new Map();

// Line-buffered JSON-RPC reader
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete tail
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // not JSON — ignore
    }
  }
});

/**
 * Send a JSON-RPC request. For notifications (method starts with "notifications/"),
 * fire-and-forget with a short delay. Otherwise return a promise that resolves
 * with the response or rejects on timeout.
 */
function send(method, params) {
  const isNotification = method.startsWith("notifications/");
  const id = isNotification ? undefined : ++msgId;
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  server.stdin.write(message);

  if (isNotification) {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, TEST_TIMEOUT_MS);

    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

/**
 * Assert a single test condition.
 */
function assert(name, condition, actual) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    actual: ${typeof actual === "object" ? JSON.stringify(actual) : actual}`);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log("MCP Osascript — Integration Tests\n");

  // 1. Initialize
  console.log("[initialize]");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  assert("initialize succeeds", init.result != null, init);
  await send("notifications/initialized", {});

  // 2. List tools — should return 12 tools
  console.log("\n[tools/list]");
  const tools = await send("tools/list", {});
  assert("tools/list returns 12 tools", tools.result.tools.length === 12, tools.result.tools.length);

  // 3. run_osascript — simple math
  console.log("\n[run_osascript]");
  const r1 = await send("tools/call", { name: "run_osascript", arguments: { script: "return 2 + 2" } });
  assert("basic AppleScript (2+2)", r1.result.content[0].text === "4", r1.result.content[0].text);

  // 4. run_osascript — JXA
  const r2 = await send("tools/call", { name: "run_osascript", arguments: { script: "40 + 2", language: "javascript" } });
  assert("JXA (40+2)", r2.result.content[0].text === "42", r2.result.content[0].text);

  // 5. run_osascript — empty script rejected
  const r3 = await send("tools/call", { name: "run_osascript", arguments: { script: "" } });
  assert("empty script rejected", r3.result.isError === true, r3.result);

  // 6. run_osascript — oversized script rejected
  const r4 = await send("tools/call", { name: "run_osascript", arguments: { script: "x".repeat(60000) } });
  assert("oversized script rejected", r4.result.isError === true, r4.result);

  // 7. get_clipboard + set_clipboard round-trip
  console.log("\n[clipboard]");
  await send("tools/call", { name: "set_clipboard", arguments: { content: "mcp-test-123" } });
  const r5 = await send("tools/call", { name: "get_clipboard", arguments: {} });
  assert("clipboard round-trip", r5.result.content[0].text === "mcp-test-123", r5.result.content[0].text);

  // 8. send_notification
  console.log("\n[send_notification]");
  const r6 = await send("tools/call", { name: "send_notification", arguments: { title: "MCP Test", message: "Integration test passed!" } });
  assert("send_notification succeeds", !r6.result.isError, r6.result);

  // 9. open_url — valid https
  console.log("\n[open_url]");
  const r7 = await send("tools/call", { name: "open_url", arguments: { url: "https://example.com" } });
  assert("https accepted", !r7.result.isError, r7.result);

  // 10. open_url — file:// rejected
  const r8 = await send("tools/call", { name: "open_url", arguments: { url: "file:///etc/passwd" } });
  assert("file:// rejected", r8.result.isError === true, r8.result);

  // 11. open_url — smb:// rejected
  const r9 = await send("tools/call", { name: "open_url", arguments: { url: "smb://evil.com/share" } });
  assert("smb:// rejected", r9.result.isError === true, r9.result);

  // 12. open_app — Finder (always exists)
  console.log("\n[open_app]");
  const r10 = await send("tools/call", { name: "open_app", arguments: { name: "Finder" } });
  assert("open Finder", !r10.result.isError, r10.result);

  // 13. open_app — nonexistent
  const r11 = await send("tools/call", { name: "open_app", arguments: { name: "ThisAppDoesNotExist12345" } });
  assert("nonexistent app rejected", r11.result.isError === true, r11.result);

  // 14. get_frontmost_app — returns name
  console.log("\n[get_frontmost_app]");
  const r12 = await send("tools/call", { name: "get_frontmost_app", arguments: {} });
  assert("returns app name", r12.result.content[0].text.includes("name"), r12.result.content[0].text);

  // 15. manage_windows list (may fail with Accessibility permission error — that's OK)
  console.log("\n[manage_windows]");
  const r13 = await send("tools/call", { name: "manage_windows", arguments: { action: "list" } });
  const r13ok = !r13.result.isError || r13.result.content[0].text.includes("Accessibility");
  assert("list windows (or accessibility error)", r13ok, r13.result);

  // 16. app_menu list on Finder (may fail with Accessibility permission error — that's OK)
  console.log("\n[app_menu]");
  const r14 = await send("tools/call", { name: "app_menu", arguments: { action: "list", app: "Finder" } });
  const r14ok = !r14.result.isError || r14.result.content[0].text.includes("Accessibility");
  assert("list Finder menus (or accessibility error)", r14ok, r14.result);

  // 17. press_key — invalid key
  console.log("\n[press_key]");
  const r15 = await send("tools/call", { name: "press_key", arguments: { key: "nonexistent_key_xyz" } });
  assert("invalid key rejected", r15.result.isError === true, r15.result);

  // 18. Prototype pollution protection
  console.log("\n[security]");
  const r16 = await send("tools/call", { name: "constructor", arguments: {} });
  assert("prototype pollution blocked", r16.result.isError === true, r16.result);

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  server.kill("SIGTERM");
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  server.kill("SIGKILL");
  process.exit(1);
});
