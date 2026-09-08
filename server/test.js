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

  // 2. List tools — should return 17 tools
  console.log("\n[tools/list]");
  const tools = await send("tools/list", {});
  assert("tools/list returns 17 tools", tools.result.tools.length === 17, tools.result.tools.length);

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
  assert("clipboard round-trip", r5.result.content[0].text.includes("mcp-test-123"), r5.result.content[0].text);
  assert("clipboard marked untrusted", r5.result.content[0].text.includes("<untrusted-data"), r5.result.content[0].text);

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

  // =========================================================================
  // NEW TESTS (19–41)
  // =========================================================================

  // ── type_text ──────────────────────────────────────────────────────────────

  // 19. empty text rejected
  console.log("\n[type_text]");
  const t19 = await send("tools/call", { name: "type_text", arguments: { text: "" } });
  assert("empty text rejected", t19.result.isError === true, t19.result);

  // 20. over-500-char text rejected
  const t20 = await send("tools/call", { name: "type_text", arguments: { text: "a".repeat(501) } });
  assert("over-500-char text rejected", t20.result.isError === true, t20.result);

  // 21. valid text (accept success or accessibility error)
  const t21 = await send("tools/call", { name: "type_text", arguments: { text: "hello" } });
  const t21ok = !t21.result.isError || t21.result.content[0].text.includes("Accessibility");
  assert("valid text (success or accessibility error)", t21ok, t21.result);

  // ── press_key ──────────────────────────────────────────────────────────────

  // 22. valid named key "escape" (accept success or accessibility error)
  console.log("\n[press_key — extended]");
  const t22 = await send("tools/call", { name: "press_key", arguments: { key: "escape" } });
  const t22ok = !t22.result.isError || t22.result.content[0].text.includes("Accessibility");
  assert("named key escape (success or accessibility error)", t22ok, t22.result);

  // 23. single char "a" with modifiers ["command"] (accept success or accessibility error)
  const t23 = await send("tools/call", { name: "press_key", arguments: { key: "a", modifiers: ["command"] } });
  const t23ok = !t23.result.isError || t23.result.content[0].text.includes("Accessibility");
  assert("char 'a' + command (success or accessibility error)", t23ok, t23.result);

  // 24. invalid modifier rejected
  const t24 = await send("tools/call", { name: "press_key", arguments: { key: "a", modifiers: ["super"] } });
  assert("invalid modifier rejected", t24.result.isError === true, t24.result);

  // ── get_browser_tabs ───────────────────────────────────────────────────────

  // 25. invalid browser name rejected
  console.log("\n[get_browser_tabs]");
  const t25 = await send("tools/call", { name: "get_browser_tabs", arguments: { browser: "firefox" } });
  assert("invalid browser name rejected", t25.result.isError === true, t25.result);

  // 26. browser="safari" (accept success, not-running, or automation error)
  const t26 = await send("tools/call", { name: "get_browser_tabs", arguments: { browser: "safari" } });
  const t26ok = !t26.result.isError
    || t26.result.content[0].text.includes("not running")
    || t26.result.content[0].text.includes("Automation");
  assert("safari tabs (success, not-running, or automation error)", t26ok, t26.result);

  // ── manage_windows ─────────────────────────────────────────────────────────

  // 27. invalid action rejected
  console.log("\n[manage_windows — extended]");
  const t27 = await send("tools/call", { name: "manage_windows", arguments: { action: "destroy" } });
  assert("invalid action rejected", t27.result.isError === true, t27.result);

  // 28. move without position rejected
  const t28 = await send("tools/call", { name: "manage_windows", arguments: { action: "move", app: "Finder" } });
  assert("move without position rejected", t28.result.isError === true, t28.result);

  // 29. resize below minimum rejected (size: {width: 50, height: 50})
  const t29 = await send("tools/call", { name: "manage_windows", arguments: { action: "resize", app: "Finder", size: { width: 50, height: 50 } } });
  assert("resize below minimum rejected", t29.result.isError === true, t29.result);

  // 30. non-integer window index rejected
  const t30 = await send("tools/call", { name: "manage_windows", arguments: { action: "list", app: "Finder", window: 1.5 } });
  assert("non-integer window index rejected", t30.result.isError === true, t30.result);

  // ── app_menu ───────────────────────────────────────────────────────────────

  // 31. missing app rejected
  console.log("\n[app_menu — extended]");
  const t31 = await send("tools/call", { name: "app_menu", arguments: { action: "list", app: "" } });
  assert("missing app rejected", t31.result.isError === true, t31.result);

  // 32. click without menu_path rejected
  const t32 = await send("tools/call", { name: "app_menu", arguments: { action: "click", app: "Finder" } });
  assert("click without menu_path rejected", t32.result.isError === true, t32.result);

  // 33. click with menu_path length 1 rejected
  const t33 = await send("tools/call", { name: "app_menu", arguments: { action: "click", app: "Finder", menu_path: ["File"] } });
  assert("click with menu_path length 1 rejected", t33.result.isError === true, t33.result);

  // 34. invalid action rejected
  const t34 = await send("tools/call", { name: "app_menu", arguments: { action: "hover", app: "Finder" } });
  assert("invalid action rejected", t34.result.isError === true, t34.result);

  // ── set_clipboard ──────────────────────────────────────────────────────────

  // 35. missing content rejected
  console.log("\n[set_clipboard — extended]");
  const t35 = await send("tools/call", { name: "set_clipboard", arguments: {} });
  assert("missing content rejected", t35.result.isError === true, t35.result);

  // 36. number instead of string rejected
  const t36 = await send("tools/call", { name: "set_clipboard", arguments: { content: 12345 } });
  assert("number instead of string rejected", t36.result.isError === true, t36.result);

  // ── run_osascript — extended ───────────────────────────────────────────────

  // 37. invalid language rejected
  console.log("\n[run_osascript — extended]");
  const t37 = await send("tools/call", { name: "run_osascript", arguments: { script: "return 1", language: "python" } });
  assert("invalid language rejected", t37.result.isError === true, t37.result);

  // 38. syntax error script returns isError with friendly message
  const t38 = await send("tools/call", { name: "run_osascript", arguments: { script: "this is not valid applescript @@##$$" } });
  assert("syntax error returns isError", t38.result.isError === true, t38.result);

  // 39. timeout enforcement: script "delay 10" with timeout=2 (isError, completes in <5s)
  const t39start = Date.now();
  const t39 = await send("tools/call", { name: "run_osascript", arguments: { script: "delay 10", timeout: 2 } });
  const t39elapsed = Date.now() - t39start;
  assert(
    "timeout enforcement (isError within 5s)",
    t39.result.isError === true && t39elapsed < 5000,
    `isError=${t39.result.isError}, elapsed=${t39elapsed}ms`
  );

  // ── open_url — extended ────────────────────────────────────────────────────

  // 40. mailto: scheme accepted
  console.log("\n[open_url — extended]");
  const t40 = await send("tools/call", { name: "open_url", arguments: { url: "mailto:test@example.com" } });
  assert("mailto: scheme accepted", !t40.result.isError, t40.result);

  // 41. javascript: scheme rejected
  const t41 = await send("tools/call", { name: "open_url", arguments: { url: "javascript:alert(1)" } });
  assert("javascript: scheme rejected", t41.result.isError === true, t41.result);

  // ── screenshot ─────────────────────────────────────────────────────────────

  console.log("\n[screenshot]");

  // 42. fullscreen screenshot to /tmp
  const t42 = await send("tools/call", { name: "screenshot", arguments: { mode: "fullscreen", path: "/tmp/mcp-test-screenshot.png", overwrite: true } });
  assert("fullscreen screenshot (success or permission error)", !t42.result.isError || t42.result.content[0].text.includes("permission"), t42.result);

  // 43. region mode without region rejected
  const t43 = await send("tools/call", { name: "screenshot", arguments: { mode: "region" } });
  assert("region without coords rejected", t43.result.isError === true, t43.result);

  // 44. window mode for nonexistent app
  const t44 = await send("tools/call", { name: "screenshot", arguments: { mode: "window", app: "NonExistentApp12345" } });
  assert("window mode nonexistent app rejected", t44.result.isError === true, t44.result);

  // ── app_visibility ─────────────────────────────────────────────────────────

  console.log("\n[app_visibility]");

  // 45. invalid action rejected
  const t45 = await send("tools/call", { name: "app_visibility", arguments: { action: "minimize", app: "Finder" } });
  assert("invalid action rejected", t45.result.isError === true, t45.result);

  // 46. missing app rejected
  const t46 = await send("tools/call", { name: "app_visibility", arguments: { action: "hide", app: "" } });
  assert("missing app rejected", t46.result.isError === true, t46.result);

  // 47. invalid app name rejected
  const t47 = await send("tools/call", { name: "app_visibility", arguments: { action: "hide", app: "Bad/App" } });
  assert("invalid app name rejected", t47.result.isError === true, t47.result);

  // 48. hide Finder (success or accessibility error)
  const t48 = await send("tools/call", { name: "app_visibility", arguments: { action: "hide", app: "Finder" } });
  assert("hide Finder (success or accessibility)", !t48.result.isError || t48.result.content[0].text.includes("ccessib"), t48.result);

  // 49. unhide Finder
  const t49 = await send("tools/call", { name: "app_visibility", arguments: { action: "unhide", app: "Finder" } });
  assert("unhide Finder (success or accessibility)", !t49.result.isError || t49.result.content[0].text.includes("ccessib"), t49.result);

  // ── file_open ──────────────────────────────────────────────────────────────

  console.log("\n[file_open]");

  // 50. missing path rejected
  const t50 = await send("tools/call", { name: "file_open", arguments: { path: "" } });
  assert("missing path rejected", t50.result.isError === true, t50.result);

  // 51. open /tmp (should succeed — it's a directory)
  const t51 = await send("tools/call", { name: "file_open", arguments: { path: "/tmp" } });
  assert("open /tmp succeeds", !t51.result.isError, t51.result);

  // 52. invalid app name rejected
  const t52 = await send("tools/call", { name: "file_open", arguments: { path: "/tmp", app: "Bad/App" } });
  assert("invalid app name rejected", t52.result.isError === true, t52.result);

  // ── run_shortcut ───────────────────────────────────────────────────────────

  console.log("\n[run_shortcut]");

  // 53. list shortcuts (should succeed)
  const t53 = await send("tools/call", { name: "run_shortcut", arguments: { action: "list" } });
  assert("list shortcuts succeeds", !t53.result.isError, t53.result);

  // 54. invalid action rejected
  const t54 = await send("tools/call", { name: "run_shortcut", arguments: { action: "delete" } });
  assert("invalid action rejected", t54.result.isError === true, t54.result);

  // 55. run without name rejected
  const t55 = await send("tools/call", { name: "run_shortcut", arguments: { action: "run" } });
  assert("run without name rejected", t55.result.isError === true, t55.result);

  // 56. run with empty name rejected
  const t56 = await send("tools/call", { name: "run_shortcut", arguments: { action: "run", name: "" } });
  assert("run with empty name rejected", t56.result.isError === true, t56.result);

  // ── v1.1.2 regression tests ────────────────────────────────────────────────

  console.log("\n[regressions]");

  // 57. screenshot: unknown mode rejected instead of silently falling back to fullscreen
  const t57 = await send("tools/call", { name: "screenshot", arguments: { mode: "everything" } });
  assert("screenshot unknown mode rejected", t57.result.isError === true, t57.result);

  // 58. screenshot: unknown format rejected
  const t58 = await send("tools/call", { name: "screenshot", arguments: { format: "bmp" } });
  assert("screenshot unknown format rejected", t58.result.isError === true, t58.result);

  // 59. screenshot: clipboard mode honours mode=window (used to silently shoot fullscreen)
  const t59 = await send("tools/call", { name: "screenshot", arguments: { mode: "window", app: "NonExistentApp12345", clipboard: true } });
  assert("screenshot window+clipboard honours mode", t59.result.isError === true, t59.result);

  // 60. file_open: an absolute path starting with "-" is a filename, not a flag
  const t60 = await send("tools/call", { name: "file_open", arguments: { path: "/tmp/-h" } });
  const t60ok = t60.result.isError === true && t60.result.content[0].text.includes("does not exist");
  assert("file_open treats leading-dash path as filename", t60ok, t60.result.content[0].text);

  // 61. manage_windows: dead 'display' param is gone from the schema
  const schema = tools.result.tools.find((t) => t.name === "manage_windows").inputSchema;
  assert("manage_windows has no dead 'display' param", schema.properties.display === undefined, Object.keys(schema.properties));

  // 62. type_text restores the clipboard it borrowed
  await send("tools/call", { name: "set_clipboard", arguments: { content: "sentinel-clip-42" } });
  const t62type = await send("tools/call", { name: "type_text", arguments: { text: "x" } });
  const t62clip = await send("tools/call", { name: "get_clipboard", arguments: {} });
  // Only meaningful when the paste actually ran — without Accessibility it fails early.
  const t62ok = t62type.result.isError
    ? true
    : t62clip.result.content[0].text.includes("sentinel-clip-42");
  assert("type_text restores clipboard (or accessibility denied)", t62ok, t62clip.result.content[0].text);

  // 63. CGWindowList bridge: deepUnwrap on a raw CFArrayRef used to yield a
  //     function, not an array — so screenshot's window list was always empty.
  const t63 = await send("tools/call", { name: "run_osascript", arguments: {
    language: "javascript",
    script: `ObjC.import("CoreGraphics");
      var wins = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
      JSON.stringify({ isArray: Array.isArray(wins), len: wins.length });`,
  } });
  let t63parsed = {};
  try { t63parsed = JSON.parse(t63.result.content[0].text); } catch {}
  assert("CGWindowList bridges to a real array", t63parsed.isArray === true && t63parsed.len > 0, t63.result.content[0].text);

  // 64. screenshot window mode must reach the capture, not die in the lookup
  //     (kCGWindowOwnerName is localized — matching is done on PID now).
  const front = await send("tools/call", { name: "get_frontmost_app", arguments: {} });
  const frontName = JSON.parse(front.result.content[0].text).name;
  const t64 = await send("tools/call", { name: "screenshot", arguments: { mode: "window", app: frontName, path: "/tmp/mcp-test-window.png", overwrite: true } });
  const t64text = t64.result.content[0].text;
  const t64ok = !t64.result.isError || t64text.includes("No windows found");
  assert("screenshot window mode resolves frontmost app", t64ok, t64text);

  // ── security audit regressions (v1.1.3) ───────────────────────────────────

  console.log("\n[audit regressions]");

  // 65. file_open must not become an unrestricted URL launcher
  const a65 = await send("tools/call", { name: "file_open", arguments: { path: "smb://attacker.example/share" } });
  assert("file_open rejects URL schemes", a65.result.isError === true && a65.result.content[0].text.includes("open_url"), a65.result.content[0].text);

  // 66. relative paths have no meaning server-side
  const a66 = await send("tools/call", { name: "file_open", arguments: { path: "relative/path.txt" } });
  assert("file_open rejects relative path", a66.result.isError === true, a66.result.content[0].text);

  // 67. screenshot must not silently clobber an existing file
  const a67 = await send("tools/call", { name: "screenshot", arguments: { mode: "region", region: { x: 0, y: 0, width: 100, height: 100 }, path: "/tmp/mcp-test-screenshot.png" } });
  assert("screenshot refuses to overwrite by default", a67.result.isError === true && a67.result.content[0].text.includes("overwrite"), a67.result.content[0].text);

  // 68. extension must match format, so 'path' cannot target an arbitrary file
  const a68 = await send("tools/call", { name: "screenshot", arguments: { mode: "fullscreen", path: "/tmp/mcp-test.zshrc" } });
  assert("screenshot rejects mismatched extension", a68.result.isError === true, a68.result.content[0].text);

  // 69. press_key: prototype-chain names must not reach the script
  for (const proto of ["constructor", "__proto__"]) {
    const a69 = await send("tools/call", { name: "press_key", arguments: { key: proto } });
    assert(`press_key rejects '${proto}'`, a69.result.isError === true && a69.result.content[0].text.includes("Unknown key"), a69.result.content[0].text);
  }

  // 70. Infinity survives JSON.parse and used to splice into the script
  const a70 = await send("tools/call", { name: "manage_windows", arguments: { action: "move", app: "Finder", position: { x: 1e999, y: 0 } } });
  assert("manage_windows rejects non-finite position", a70.result.isError === true, a70.result.content[0].text);

  // 71. Infinity also sailed past the `width < 100` guard
  const a71 = await send("tools/call", { name: "manage_windows", arguments: { action: "resize", app: "Finder", size: { width: 1e999, height: 500 } } });
  assert("manage_windows rejects non-finite size", a71.result.isError === true, a71.result.content[0].text);

  // 72. window geometry must be real numbers, not 0 from a NaN coercion
  const a72 = await send("tools/call", { name: "manage_windows", arguments: { action: "list", app: "Finder" } });
  let a72ok = a72.result.content[0].text.includes("Accessibility");
  if (!a72ok) {
    const body = a72.result.content[0].text.replace(/^[\s\S]*?<untrusted-data[^>]*>/, "").replace(/<\/untrusted-data>[\s\S]*$/, "");
    const parsed = JSON.parse(body);
    a72ok = parsed.windows.length === 0 || parsed.windows.every(
      (w) => Number.isFinite(w.size.width) && Number.isFinite(w.size.height) && w.size.width > 0
    );
  }
  assert("window list reports parseable geometry", a72ok, a72.result.content[0].text.slice(0, 200));

  // 73. menu_path element types are unchecked by the SDK
  const a73 = await send("tools/call", { name: "app_menu", arguments: { action: "click", app: "Finder", menu_path: ["File", 5] } });
  assert("app_menu rejects non-string menu_path entry", a73.result.isError === true && !a73.result.content[0].text.includes("Internal error"), a73.result.content[0].text);

  // 74. app_visibility must match open_app's app-name rule
  const a74 = await send("tools/call", { name: "app_visibility", arguments: { action: "hide", app: "Disk:Applications:Foo" } });
  assert("app_visibility rejects ':' in app name", a74.result.isError === true, a74.result.content[0].text);

  // 75. escaping can double the length — the limit must apply to the escaped form
  const a75 = await send("tools/call", { name: "set_clipboard", arguments: { content: "\\".repeat(30000) } });
  assert("set_clipboard limits the escaped length", a75.result.isError === true && !a75.result.content[0].text.includes("Internal error"), a75.result.content[0].text);

  // 76. browser tabs are attacker-controlled and must be fenced
  const a76 = await send("tools/call", { name: "get_browser_tabs", arguments: { browser: "safari" } });
  const a76ok = a76.result.isError || a76.result.content[0].text.includes("<untrusted-data");
  assert("browser tabs marked untrusted", a76ok, a76.result.content[0].text.slice(0, 120));

  // 77. run_shortcut: -i is --input-path and must be staged as a file, with the
  //     options BEFORE "--" (otherwise swift-argument-parser rejects them as
  //     unexpected positionals and the input silently never arrives).
  const a77 = await send("tools/call", { name: "run_shortcut", arguments: { action: "run", name: "NoSuchShortcut12345", input: "hello" } });
  const a77text = a77.result.content[0].text;
  assert("run_shortcut passes input without arg-order breakage", !a77text.includes("unexpected argument"), a77text);

  // 78. input must be text, not a caller-supplied path (that was a file-read primitive)
  const a78 = await send("tools/call", { name: "run_shortcut", arguments: { action: "run", name: "X", input: { a: 1 } } });
  assert("run_shortcut rejects non-string input", a78.result.isError === true && a78.result.content[0].text.includes("must be a string"), a78.result.content[0].text);

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
