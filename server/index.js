#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  executeScript,
  executeAppleScript,
  classifyError,
  safeError,
  MAX_SCRIPT_LENGTH,
} from "./executor.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFileCb);

// ─────────────────────────────────────────────────────────────────────────────
// Result helpers
// ─────────────────────────────────────────────────────────────────────────────

function errorResult(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function textResult(text) {
  let out = text || "(no output)";
  if (out.length > 50000) {
    out = out.slice(0, 50000) + "\n\n… truncated (" + text.length + " total chars)";
  }
  return { content: [{ type: "text", text: out }] };
}

function escapeAS(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Run a shell command safely via execFile (no shell injection possible) */
async function runShell(cmd, args, timeoutMs = 10000) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME, LANG: process.env.LANG || "en_US.UTF-8" },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, error: safeError(err) };
  }
}

/** Run AppleScript; return textResult on success, errorResult on failure */
async function runAS(script, timeoutMs) {
  const r = await executeAppleScript(script, timeoutMs);
  if (r.exitCode !== 0 || r.timedOut) {
    const err = classifyError(r.stderr, r.exitCode, r.timedOut);
    return { ok: false, error: err };
  }
  return { ok: true, stdout: r.stdout.trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal handling
// ─────────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("[mcp-osascript] shutting down");

  // Force exit safety net
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();

  try {
    await server.close();
  } catch {
    // transport may already be closed
  }

  process.exitCode = 0;
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (17 tools)
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "run_osascript",
    description:
      "Execute an AppleScript or JXA (JavaScript for Automation) script on macOS. " +
      "Automate any scriptable app, control system settings, manage files, and more. " +
      "Supports multiline scripts. Use language='javascript' for JXA. " +
      "Timeout: 30s default, max 120s. Max script: 50 KB. Max output: 50 KB.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The script source code to execute." },
        language: { type: "string", enum: ["applescript", "javascript"], default: "applescript", description: "Script language." },
        timeout: { type: "number", description: "Timeout in seconds (1-120). Default: 30." },
      },
      required: ["script"],
    },
  },
  {
    name: "get_clipboard",
    description: "Get the current macOS clipboard contents as plain text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_clipboard",
    description: "Set the macOS clipboard to the given text content.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "Text to place on the clipboard." } },
      required: ["content"],
    },
  },
  {
    name: "send_notification",
    description: "Display a macOS notification banner with a title and message.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title." },
        message: { type: "string", description: "Notification body text." },
        sound: { type: "string", description: 'Optional sound name (e.g. "default", "Glass").' },
      },
      required: ["title", "message"],
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the default browser. Only http, https, and mailto schemes are allowed.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open." } },
      required: ["url"],
    },
  },
  {
    name: "open_app",
    description: "Launch or activate a macOS application by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Application name as shown in Finder." } },
      required: ["name"],
    },
  },
  {
    name: "get_frontmost_app",
    description: "Get the name and bundle ID of the frontmost (active) application. May require Automation permission for System Events in System Settings > Privacy & Security > Automation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_browser_tabs",
    description: "List open tabs in Safari, Chrome, or Arc (title + URL for each tab).",
    inputSchema: {
      type: "object",
      properties: {
        browser: { type: "string", enum: ["safari", "chrome", "arc"], description: "Browser to query. Auto-detects if omitted." },
      },
    },
  },
  {
    name: "type_text",
    description: "Type text into the frontmost application via System Events keystroke. Requires Accessibility permission. Max 500 chars.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 500, description: "Text to type (max 500 characters)." } },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description: "Press a key with optional modifiers (e.g. return, tab, c with command). Requires Accessibility permission.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Key name or single character (e.g. "return", "tab", "c", "f5").' },
        modifiers: { type: "array", items: { type: "string", enum: ["command", "option", "control", "shift"] }, description: "Modifier keys." },
      },
      required: ["key"],
    },
  },
  {
    name: "manage_windows",
    description: "List, move, resize, minimize, fullscreen, or close application windows. For multi-monitor setups call get_displays first, then pass absolute coordinates to 'move'. Requires Accessibility permission for most actions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "move", "resize", "minimize", "fullscreen", "close"], description: "Window action." },
        app: { type: "string", description: "App name. Defaults to frontmost." },
        window: { type: "number", default: 1, description: "Window index (1-based)." },
        position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, description: "For move." },
        size: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } }, description: "For resize." },
      },
      required: ["action"],
    },
  },
  {
    name: "get_displays",
    description: "Get information about all connected displays — position, size, and which is the main display. Useful for multi-monitor window management.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "app_menu",
    description: "List available menu items or click a specific menu item in an application. Requires Accessibility permission.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "click"], description: '"list" to enumerate, "click" to activate.' },
        app: { type: "string", description: "Application name." },
        menu_path: { type: "array", items: { type: "string" }, description: 'Menu path, e.g. ["File", "Save"]. Required for click.' },
      },
      required: ["action", "app"],
    },
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of the full screen, a region, or a specific app window. Requires Screen Recording permission in System Settings > Privacy & Security > Screen Recording.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fullscreen", "region", "window"], default: "fullscreen", description: "Capture mode." },
        path: { type: "string", description: "Output file path. Defaults to /tmp/screenshot-<timestamp>.png." },
        app: { type: "string", description: "For window mode: app name to capture." },
        window: { type: "number", default: 1, description: "For window mode: window index (1-based)." },
        region: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
          description: "For region mode: capture area {x, y, width, height}.",
        },
        display: { type: "number", description: "For fullscreen mode: display number (1=main)." },
        format: { type: "string", enum: ["png", "jpg"], default: "png", description: "Image format." },
        clipboard: { type: "boolean", default: false, description: "Save to clipboard instead of file." },
      },
    },
  },
  {
    name: "app_visibility",
    description: "Hide, unhide (show), or quit an application. Hiding keeps the app running but removes its windows from view (like Cmd+H). Requires Accessibility permission for hide/unhide.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["hide", "unhide", "quit"], description: "Action to perform." },
        app: { type: "string", description: "Application name." },
      },
      required: ["action", "app"],
    },
  },
  {
    name: "file_open",
    description: "Open a file or folder, optionally in a specific application. Uses macOS 'open' command.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or folder path to open." },
        app: { type: "string", description: "Application to open the file with. If omitted, uses the default app." },
      },
      required: ["path"],
    },
  },
  {
    name: "run_shortcut",
    description: "List available Apple Shortcuts or run a specific shortcut by name.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "run"], description: "Action to perform." },
        name: { type: "string", description: "Shortcut name (required for run)." },
        input: { type: "string", description: "Optional text input to pass to the shortcut." },
      },
      required: ["action"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Permission error constants
// ─────────────────────────────────────────────────────────────────────────────

const ACCESSIBILITY_MSG =
  "Accessibility permission required. Grant access to 'osascript' (or the parent app like Terminal/Claude) in System Settings > Privacy & Security > Accessibility.";

// ─────────────────────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS = Object.create(null);

// ── 1. run_osascript ─────────────────────────────────────────────────────────

HANDLERS["run_osascript"] = async (args) => {
  const { script, language = "applescript", timeout = 30 } = args;
  if (!script || typeof script !== "string" || script.trim() === "") {
    return errorResult("Parameter 'script' must be a non-empty string.");
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    return errorResult(`Script too long (${script.length} chars, max ${MAX_SCRIPT_LENGTH}).`);
  }
  if (language !== "applescript" && language !== "javascript") {
    return errorResult('Parameter \'language\' must be "applescript" or "javascript".');
  }
  const timeoutSec = Math.max(1, Math.min(120, Number(timeout) || 30));
  try {
    const r = await executeScript(script, language, timeoutSec * 1000);
    if (r.exitCode !== 0 || r.timedOut) {
      const err = classifyError(r.stderr, r.exitCode, r.timedOut);
      return errorResult(err.friendlyMessage);
    }
    return textResult(r.stdout.trim());
  } catch (err) {
    return errorResult(`run_osascript: ${safeError(err)}`);
  }
};

// ── 2. get_clipboard ─────────────────────────────────────────────────────────

HANDLERS["get_clipboard"] = async () => {
  const r = await runAS("the clipboard as text");
  if (!r.ok) {
    const msg = r.error.friendlyMessage || "";
    if (msg.includes("Can't make") || msg.includes("-1700") || msg.includes("clipboard")) {
      return textResult("Clipboard contains non-text data (image, file, etc.)");
    }
    return errorResult(`Failed to read clipboard: ${r.error.friendlyMessage}`);
  }
  return textResult(r.stdout || "(clipboard is empty)");
};

// ── 3. set_clipboard ─────────────────────────────────────────────────────────

HANDLERS["set_clipboard"] = async (args) => {
  if (args.content == null || typeof args.content !== "string") {
    return errorResult("Parameter 'content' must be a string.");
  }
  if (args.content.length > MAX_SCRIPT_LENGTH) {
    return errorResult(`Content too long (${args.content.length} chars). Max: ${MAX_SCRIPT_LENGTH}.`);
  }
  const r = await runAS(`set the clipboard to "${escapeAS(args.content)}"`);
  if (!r.ok) return errorResult(`Failed to set clipboard: ${r.error.friendlyMessage}`);
  return textResult(`Clipboard set (${args.content.length} chars)`);
};

// ── 4. send_notification ─────────────────────────────────────────────────────

HANDLERS["send_notification"] = async (args) => {
  if (!args.title || typeof args.title !== "string") return errorResult("Parameter 'title' is required.");
  if (!args.message || typeof args.message !== "string") return errorResult("Parameter 'message' is required.");

  let script = `display notification "${escapeAS(args.message.slice(0, 500))}" with title "${escapeAS(args.title.slice(0, 100))}"`;
  if (args.sound && typeof args.sound === "string") {
    script += ` sound name "${escapeAS(args.sound)}"`;
  }
  const r = await runAS(script);
  if (!r.ok) return errorResult(`Failed to send notification: ${r.error.friendlyMessage}`);
  return textResult("Notification sent.");
};

// ── 5. open_url ──────────────────────────────────────────────────────────────

HANDLERS["open_url"] = async (args) => {
  if (!args.url || typeof args.url !== "string" || !args.url.trim()) {
    return errorResult("Parameter 'url' is required.");
  }
  let parsed;
  try {
    parsed = new URL(args.url.trim());
  } catch {
    return errorResult("Invalid URL format.");
  }
  const allowed = ["http:", "https:", "mailto:"];
  if (!allowed.includes(parsed.protocol)) {
    return errorResult(`Scheme "${parsed.protocol}" is not allowed. Allowed: ${allowed.join(", ")}`);
  }
  const r = await runAS(`open location "${escapeAS(args.url.trim())}"`);
  if (!r.ok) return errorResult(`Failed to open URL: ${r.error.friendlyMessage}`);
  return textResult(`Opened: ${args.url.trim()}`);
};

// ── 6. open_app ──────────────────────────────────────────────────────────────

HANDLERS["open_app"] = async (args) => {
  if (!args.name || typeof args.name !== "string" || !args.name.trim()) {
    return errorResult("Parameter 'name' is required.");
  }
  const appName = args.name.trim();
  if (appName.includes("/") || appName.includes(":")) {
    return errorResult("Application name must not contain '/' or ':' characters.");
  }
  const safeName = escapeAS(appName);
  // Check if app exists
  const check = await runAS(`id of application "${safeName}"`);
  if (!check.ok) {
    return errorResult(`Application '${appName}' not found or not installed.`);
  }
  // Activate
  const r = await runAS(`tell application "${safeName}" to activate`);
  if (!r.ok) {
    if (r.error.category === "permission_automation") {
      return errorResult(`Automation permission denied for '${appName}'. Grant permission in System Settings > Privacy & Security > Automation.`);
    }
    return errorResult(`Failed to activate '${appName}': ${r.error.friendlyMessage}`);
  }
  return textResult(`Activated: ${appName}`);
};

// ── 7. get_frontmost_app ─────────────────────────────────────────────────────

HANDLERS["get_frontmost_app"] = async () => {
  const script = `tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc
  set appId to bundle identifier of frontProc
end tell
return appName & "|" & appId`;
  const r = await runAS(script);
  if (!r.ok) {
    if (r.error.category === "permission_automation") {
      return errorResult("Automation permission denied for System Events. Grant permission in System Settings > Privacy & Security > Automation.");
    }
    return errorResult(`Cannot determine frontmost app: ${r.error.friendlyMessage}`);
  }
  const sep = r.stdout.lastIndexOf("|");
  const name = sep > 0 ? r.stdout.substring(0, sep) : r.stdout;
  const bundleId = sep > 0 ? r.stdout.substring(sep + 1) : "";
  return textResult(JSON.stringify({ name, bundleId }));
};

// ── 8. get_browser_tabs ──────────────────────────────────────────────────────

HANDLERS["get_browser_tabs"] = async (args) => {
  const knownBrowsers = { safari: "Safari", chrome: "Google Chrome", arc: "Arc", "google chrome": "Google Chrome" };
  let browserApp;

  if (args.browser && typeof args.browser === "string" && args.browser.trim()) {
    browserApp = knownBrowsers[args.browser.trim().toLowerCase()];
    if (!browserApp) return errorResult(`Unknown browser '${args.browser}'. Supported: safari, chrome, arc`);
  } else {
    const detect = await runAS(`tell application "System Events" to return name of first application process whose frontmost is true`);
    if (!detect.ok) return errorResult(`Cannot detect frontmost app: ${detect.error.friendlyMessage}`);
    const frontName = detect.stdout;
    browserApp = knownBrowsers[frontName.toLowerCase()] || (["Safari", "Google Chrome", "Arc"].includes(frontName) ? frontName : null);
    if (!browserApp) return errorResult(`Frontmost app '${frontName}' is not a supported browser. Specify browser explicitly: safari, chrome, or arc.`);
  }

  const safeBrowser = escapeAS(browserApp);
  const replaceHelper = `
on replaceText(theText, searchStr, replaceStr)
  set AppleScript's text item delimiters to searchStr
  set theItems to text items of theText
  set AppleScript's text item delimiters to replaceStr
  set theText to theItems as text
  set AppleScript's text item delimiters to ""
  return theText
end replaceText`;

  let script;
  if (browserApp === "Safari") {
    script = `set tabList to {}
tell application "Safari"
  repeat with w in every window
    set ct to current tab of w
    repeat with t in every tab of w
      set tabTitle to my replaceText(name of t, "|||", "|")
      set tabURL to my replaceText(URL of t, "|||", "|")
      set isCurrent to (ct is t)
      set end of tabList to tabTitle & "|||" & tabURL & "|||" & (isCurrent as text)
    end repeat
  end repeat
end tell
set text item delimiters to linefeed
return tabList as text
${replaceHelper}`;
  } else {
    script = `set tabList to {}
tell application "${safeBrowser}"
  repeat with w in every window
    set activeIdx to active tab index of w
    set tabIdx to 0
    repeat with t in every tab of w
      set tabIdx to tabIdx + 1
      set tabTitle to my replaceText(title of t, "|||", "|")
      set tabURL to my replaceText(URL of t, "|||", "|")
      set isCurrent to (activeIdx = tabIdx)
      set end of tabList to tabTitle & "|||" & tabURL & "|||" & (isCurrent as text)
    end repeat
  end repeat
end tell
set text item delimiters to linefeed
return tabList as text
${replaceHelper}`;
  }

  const r = await runAS(script);
  if (!r.ok) {
    if (r.error.category === "permission_automation") {
      return errorResult(`Automation permission denied. Grant permission for ${browserApp} in System Settings > Privacy & Security > Automation.`);
    }
    if (r.error.category === "app_not_running") {
      return errorResult(`${browserApp} is not running. Open it first.`);
    }
    return errorResult(`Failed to get tabs: ${r.error.friendlyMessage}`);
  }
  if (!r.stdout) return textResult(JSON.stringify([]));
  const tabs = r.stdout.split("\n").map((line) => {
    const parts = line.split("|||");
    return { title: parts[0] || "", url: parts[1] || "", active: (parts[2] || "").trim().toLowerCase() === "true" };
  });
  return textResult(JSON.stringify(tabs, null, 2));
};

// ── 9. type_text ─────────────────────────────────────────────────────────────

HANDLERS["type_text"] = async (args) => {
  if (!args || typeof args.text !== "string" || args.text.length === 0) {
    return errorResult("Parameter 'text' is required and must be a non-empty string.");
  }
  if (args.text.length > 500) {
    return errorResult(`Text too long (${args.text.length} chars). Maximum: 500.`);
  }
  // Use clipboard + Cmd+V instead of keystroke to avoid keyboard layout issues
  // (keystroke sends key codes, not characters — Russian layout → garbled text).
  // The user's clipboard is saved and put back afterwards; the delay gives the
  // target app time to actually process the paste before we overwrite it.
  // Non-text clipboards (images, files) can't be restored — savedClip stays
  // empty and we leave the typed text in place rather than wiping the board.
  const r = await runAS(`set savedClip to ""
set hadClip to false
try
  set savedClip to the clipboard as text
  set hadClip to true
end try
set the clipboard to "${escapeAS(args.text)}"
tell application "System Events"
  key code 9 using command down
end tell
delay 0.3
if hadClip then set the clipboard to savedClip`);
  if (!r.ok) {
    if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
    return errorResult(r.error.friendlyMessage);
  }
  return textResult(`Typed ${args.text.length} characters`);
};

// ── 10. press_key ────────────────────────────────────────────────────────────

const KEY_CODES = {
  return: 36, enter: 76, tab: 48, space: 49, delete: 51, escape: 53,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, page_up: 116, page_down: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const VALID_MODIFIERS = ["command", "option", "control", "shift"];

HANDLERS["press_key"] = async (args) => {
  if (!args || typeof args.key !== "string" || args.key.trim() === "") {
    return errorResult("Parameter 'key' is required.");
  }
  const key = args.key.trim().toLowerCase();
  const modifiers = args.modifiers || [];
  if (!Array.isArray(modifiers)) return errorResult("Parameter 'modifiers' must be an array.");
  for (const mod of modifiers) {
    if (!VALID_MODIFIERS.includes(mod)) {
      return errorResult(`Invalid modifier '${mod}'. Valid: ${VALID_MODIFIERS.join(", ")}.`);
    }
  }

  const usingClause = modifiers.length > 0
    ? ` using {${modifiers.map((m) => m + " down").join(", ")}}`
    : "";

  let action;
  if (KEY_CODES[key] !== undefined) {
    action = `key code ${KEY_CODES[key]}${usingClause}`;
  } else if (key.length === 1) {
    action = `keystroke "${escapeAS(key)}"${usingClause}`;
  } else {
    return errorResult(`Unknown key '${args.key}'. Valid keys: ${Object.keys(KEY_CODES).join(", ")}, or any single character.`);
  }

  const r = await runAS(`tell application "System Events"\n  ${action}\nend tell`);
  if (!r.ok) {
    if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
    return errorResult(r.error.friendlyMessage);
  }
  const label = modifiers.length > 0 ? `${args.key} (+ ${modifiers.join(", ")})` : args.key;
  return textResult(`Pressed: ${label}`);
};

// ── 11. manage_windows ───────────────────────────────────────────────────────

HANDLERS["manage_windows"] = async (args) => {
  const VALID_ACTIONS = ["list", "move", "resize", "minimize", "fullscreen", "close"];
  if (!args || !VALID_ACTIONS.includes(args.action)) {
    return errorResult(`Parameter 'action' is required. Valid: ${VALID_ACTIONS.join(", ")}.`);
  }
  const { action } = args;
  const winIndex = args.window || 1;
  if (typeof winIndex !== "number" || winIndex < 1 || !Number.isInteger(winIndex)) {
    return errorResult("Parameter 'window' must be a positive integer.");
  }

  // Determine target app
  let appName;
  if (args.app && typeof args.app === "string") {
    if (/[/\\]/.test(args.app)) return errorResult("Invalid app name.");
    appName = args.app.trim();
  } else {
    const front = await runAS(`tell application "System Events" to return name of first application process whose frontmost is true`);
    if (!front.ok) return errorResult(`Cannot determine frontmost app: ${front.error.friendlyMessage}`);
    appName = front.stdout;
  }
  const escApp = escapeAS(appName);

  if (action === "list") {
    const r = await runAS(`set winList to {}
tell application "System Events" to tell process "${escApp}"
  repeat with w in every window
    set winInfo to (name of w) & "|||" & (position of w as text) & "|||" & (size of w as text)
    set end of winList to winInfo
  end repeat
end tell
set text item delimiters to linefeed
return winList as text`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    if (!r.stdout) return textResult(JSON.stringify({ app: appName, windows: [] }, null, 2));
    const windows = r.stdout.split("\n").map((line, i) => {
      const parts = line.split("|||");
      const pos = (parts[1] || "").trim().split(", ").map(Number);
      const sz = (parts[2] || "").trim().split(", ").map(Number);
      return { index: i + 1, title: (parts[0] || "").trim(), position: { x: pos[0] || 0, y: pos[1] || 0 }, size: { width: sz[0] || 0, height: sz[1] || 0 } };
    });
    return textResult(JSON.stringify({ app: appName, windows }, null, 2));
  }

  if (action === "move") {
    if (!args.position || typeof args.position.x !== "number" || typeof args.position.y !== "number") {
      return errorResult("Parameter 'position' with numeric x and y is required for 'move'.");
    }
    const { x, y } = args.position;
    const r = await runAS(`tell application "System Events" to tell process "${escApp}"\n  set position of window ${winIndex} to {${x}, ${y}}\nend tell`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult(`Moved window to (${x}, ${y})`);
  }

  if (action === "resize") {
    if (!args.size || typeof args.size.width !== "number" || typeof args.size.height !== "number") {
      return errorResult("Parameter 'size' with numeric width and height is required for 'resize'.");
    }
    const { width, height } = args.size;
    if (width < 100 || height < 100) return errorResult("Minimum size is 100x100.");
    const r = await runAS(`tell application "System Events" to tell process "${escApp}"\n  set size of window ${winIndex} to {${width}, ${height}}\nend tell`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult(`Resized window to ${width}x${height}`);
  }

  if (action === "minimize") {
    // Prefer the app's own dictionary (works even when Accessibility is denied),
    // fall back to the Accessibility API for apps with no AppleScript support
    // (Electron and friends) — those are the ones move/resize already handle.
    let r = await runAS(`tell application "${escApp}" to set miniaturized of window ${winIndex} to true`);
    if (!r.ok) {
      r = await runAS(`tell application "System Events" to tell process "${escApp}"
  set value of attribute "AXMinimized" of window ${winIndex} to true
end tell`);
    }
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult("Minimized window");
  }

  if (action === "fullscreen") {
    const r = await runAS(`tell application "System Events" to tell process "${escApp}"
  set currentFS to value of attribute "AXFullScreen" of window ${winIndex}
  set value of attribute "AXFullScreen" of window ${winIndex} to (not currentFS)
  return (not currentFS) as text
end tell`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    const newState = r.stdout.trim().toLowerCase() === "true" ? "on" : "off";
    return textResult(`Fullscreen toggled ${newState}`);
  }

  if (action === "close") {
    // Same two-step as minimize: app dictionary first, then the window's
    // Accessibility close button.
    let r = await runAS(`tell application "${escApp}" to close window ${winIndex}`);
    if (!r.ok) {
      r = await runAS(`tell application "System Events" to tell process "${escApp}"
  click (first button of window ${winIndex} whose subrole is "AXCloseButton")
end tell`);
    }
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult("Closed window");
  }
};

// ── 13. get_displays ─────────────────────────────────────────────────────────

HANDLERS["get_displays"] = async () => {
  const r = await executeScript(`
    ObjC.import("AppKit");
    var screens = $.NSScreen.screens;
    var result = [];
    for (var i = 0; i < screens.count; i++) {
      var s = screens.objectAtIndex(i);
      var f = s.frame;
      var mainH = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
      var screenY = mainH - f.origin.y - f.size.height;
      result.push({
        display: i + 1,
        x: f.origin.x,
        y: screenY,
        width: f.size.width,
        height: f.size.height,
        main: i === 0
      });
    }
    JSON.stringify(result, null, 2);
  `, "javascript");
  if (r.exitCode !== 0) return errorResult("Failed to get display info");
  return textResult(r.stdout.trim());
};

// ── 14. app_menu ─────────────────────────────────────────────────────────────

HANDLERS["app_menu"] = async (args) => {
  if (!args || !["list", "click"].includes(args.action)) {
    return errorResult("Parameter 'action' is required. Valid: list, click.");
  }
  if (!args.app || typeof args.app !== "string" || args.app.trim() === "") {
    return errorResult("Parameter 'app' is required.");
  }
  if (/[/\\]/.test(args.app)) return errorResult("Invalid app name.");

  const appName = args.app.trim();
  const escApp = escapeAS(appName);
  const menuPath = args.menu_path || [];
  if (!Array.isArray(menuPath)) return errorResult("Parameter 'menu_path' must be an array of strings.");

  if (args.action === "list") {
    let script;
    if (menuPath.length === 0) {
      script = `tell application "System Events" to tell process "${escApp}"
  set rawList to name of every menu bar item of menu bar 1
  set output to ""
  repeat with i from 1 to count of rawList
    if item i of rawList is not missing value then
      if output is not "" then set output to output & linefeed
      set output to output & (item i of rawList)
    end if
  end repeat
  return output
end tell`;
    } else {
      const escPath = menuPath.map(escapeAS);
      let menuRef = `menu "${escPath[0]}" of menu bar item "${escPath[0]}" of menu bar 1`;
      for (let i = 1; i < escPath.length; i++) {
        menuRef = `menu "${escPath[i]}" of menu item "${escPath[i]}" of ${menuRef}`;
      }
      script = `tell application "System Events" to tell process "${escApp}"
  set rawList to name of every menu item of ${menuRef}
  set output to ""
  repeat with i from 1 to count of rawList
    if item i of rawList is not missing value then
      if output is not "" then set output to output & linefeed
      set output to output & (item i of rawList)
    end if
  end repeat
  return output
end tell`;
    }
    const r = await runAS(script);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    const items = r.stdout.split("\n").filter((s) => s !== "");
    return textResult(JSON.stringify(items, null, 2));
  }

  if (args.action === "click") {
    if (!menuPath || menuPath.length < 2) {
      return errorResult('Parameter \'menu_path\' with at least 2 items is required for "click" (e.g., ["File", "Save"]).');
    }
    const escPath = menuPath.map(escapeAS);
    let menuRef = `menu "${escPath[0]}" of menu bar item "${escPath[0]}" of menu bar 1`;
    for (let i = 1; i < escPath.length - 1; i++) {
      menuRef = `menu "${escPath[i]}" of menu item "${escPath[i]}" of ${menuRef}`;
    }
    const targetItem = escPath[escPath.length - 1];
    const script = `tell application "System Events" to tell process "${escApp}"\n  click menu item "${targetItem}" of ${menuRef}\nend tell`;

    const r = await runAS(script);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      // Try to list available items for self-correction
      const parentPath = menuPath.slice(0, -1);
      const escParent = parentPath.map(escapeAS);
      let listRef = `menu "${escParent[0]}" of menu bar item "${escParent[0]}" of menu bar 1`;
      for (let i = 1; i < escParent.length; i++) {
        listRef = `menu "${escParent[i]}" of menu item "${escParent[i]}" of ${listRef}`;
      }
      const listR = await runAS(`tell application "System Events" to tell process "${escApp}"
  set rawList to name of every menu item of ${listRef}
  set output to ""
  repeat with i from 1 to count of rawList
    if item i of rawList is not missing value then
      if output is not "" then set output to output & linefeed
      set output to output & (item i of rawList)
    end if
  end repeat
  return output
end tell`);
      if (listR.ok) {
        const available = listR.stdout.split("\n").filter((s) => s !== "");
        return errorResult(`Menu item '${menuPath[menuPath.length - 1]}' not found in '${parentPath.join(" > ")}'. Available: ${JSON.stringify(available)}`);
      }
      return errorResult(r.error.friendlyMessage);
    }
    return textResult(`Clicked: ${menuPath.join(" > ")}`);
  }
};

// ── 15. screenshot ──────────────────────────────────────────────────────────

HANDLERS["screenshot"] = async (args) => {
  const VALID_MODES = ["fullscreen", "region", "window"];
  const VALID_FORMATS = ["png", "jpg"];
  const mode = args.mode || "fullscreen";
  const format = args.format || "png";
  const toClipboard = args.clipboard || false;

  if (!VALID_MODES.includes(mode)) {
    return errorResult(`Parameter 'mode' must be one of: ${VALID_MODES.join(", ")}.`);
  }
  if (!VALID_FORMATS.includes(format)) {
    return errorResult(`Parameter 'format' must be one of: ${VALID_FORMATS.join(", ")}.`);
  }

  const shellArgs = ["-x"]; // -x = no sound

  // ── Target selection — the same regardless of where the shot ends up ────────
  if (mode === "region") {
    if (!args.region || [args.region.x, args.region.y, args.region.width, args.region.height].some((v) => typeof v !== "number")) {
      return errorResult("Region mode requires region with numeric x, y, width, height.");
    }
    shellArgs.push("-R", `${args.region.x},${args.region.y},${args.region.width},${args.region.height}`);
  } else if (mode === "window") {
    let appName = args.app;
    if (!appName) {
      const front = await runAS(`tell application "System Events" to return name of first application process whose frontmost is true`);
      if (!front.ok) return errorResult(`Cannot determine frontmost app: ${front.error.friendlyMessage}`);
      appName = front.stdout;
    }
    const winIdx = args.window || 1;

    // Match on PID, not name: kCGWindowOwnerName is LOCALIZED ("Терминал",
    // "Почта") while System Events reports the English name, so name matching
    // silently found nothing on a non-English system. Fall back to the name
    // only if the PID lookup itself fails.
    const pidR = await runAS(`tell application "System Events" to return unix id of first application process whose name is "${escapeAS(appName)}"`);
    const ownerPid = pidR.ok ? Number(pidR.stdout.trim()) : NaN;

    const r = await executeScript(`
      ObjC.import("CoreGraphics");
      // CGWindowListCopyWindowInfo returns a CFArrayRef. Handing that straight to
      // deepUnwrap yields a function, not an array — the list always came back
      // empty. castRefToObject bridges the ref into a real NSArray first.
      var info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0);
      var wins = ObjC.deepUnwrap(ObjC.castRefToObject(info));
      var targetPid = ${Number.isFinite(ownerPid) ? ownerPid : "null"};
      var targetName = ${JSON.stringify(appName)};
      var matches = [];
      for (var i = 0; i < wins.length; i++) {
        if (wins[i].kCGWindowLayer !== 0) continue;
        var hit = targetPid !== null
          ? wins[i].kCGWindowOwnerPID === targetPid
          : wins[i].kCGWindowOwnerName === targetName;
        if (hit) matches.push(wins[i].kCGWindowNumber);
      }
      JSON.stringify(matches);
    `, "javascript");
    if (r.exitCode !== 0) return errorResult("Failed to get window list.");
    let windowIds;
    try { windowIds = JSON.parse(r.stdout.trim()); } catch { return errorResult("Failed to parse window IDs."); }
    if (windowIds.length === 0) return errorResult(`No windows found for '${appName}'.`);
    if (winIdx > windowIds.length) return errorResult(`Window ${winIdx} not found. ${appName} has ${windowIds.length} window(s).`);
    shellArgs.push("-l", String(windowIds[winIdx - 1]));
  } else if (args.display) {
    shellArgs.push("-D", String(Math.max(1, Math.floor(args.display))));
  }

  // ── Destination ────────────────────────────────────────────────────────────
  if (toClipboard) {
    shellArgs.push("-c");
    const r = await runShell("screencapture", shellArgs);
    if (!r.ok) return errorResult(`Screenshot failed: ${r.error}`);
    return textResult(`Screenshot saved to clipboard (${mode}).`);
  }

  const filePath = args.path || `/tmp/screenshot-${Date.now()}.${format}`;
  if (filePath.includes("\0")) return errorResult("Invalid path.");
  // "--" so a path beginning with "-" is treated as a filename, not a flag
  shellArgs.push("-t", format, "--", filePath);
  const r = await runShell("screencapture", shellArgs);
  if (!r.ok) return errorResult(`Screenshot failed: ${r.error}`);
  return textResult(`Screenshot saved: ${filePath}`);
};

// ── 16. app_visibility ──────────────────────────────────────────────────────

HANDLERS["app_visibility"] = async (args) => {
  if (!args.app || typeof args.app !== "string" || !args.app.trim()) {
    return errorResult("Parameter 'app' is required.");
  }
  if (!["hide", "unhide", "quit"].includes(args.action)) {
    return errorResult("Parameter 'action' must be hide, unhide, or quit.");
  }
  const appName = args.app.trim();
  if (/[/\\]/.test(appName)) return errorResult("Invalid app name.");
  const escApp = escapeAS(appName);

  if (args.action === "hide") {
    const r = await runAS(`tell application "System Events" to set visible of process "${escApp}" to false`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult(`Hidden: ${appName}`);
  }

  if (args.action === "unhide") {
    const r = await runAS(`tell application "System Events" to set visible of process "${escApp}" to true`);
    if (!r.ok) {
      if (r.error.category === "permission_accessibility") return errorResult(ACCESSIBILITY_MSG);
      return errorResult(r.error.friendlyMessage);
    }
    return textResult(`Shown: ${appName}`);
  }

  if (args.action === "quit") {
    const r = await runAS(`tell application "${escApp}" to quit`);
    if (!r.ok) return errorResult(`Failed to quit ${appName}: ${r.error.friendlyMessage}`);
    return textResult(`Quit: ${appName}`);
  }
};

// ── 17. file_open ───────────────────────────────────────────────────────────

HANDLERS["file_open"] = async (args) => {
  if (!args.path || typeof args.path !== "string" || !args.path.trim()) {
    return errorResult("Parameter 'path' is required.");
  }
  const filePath = args.path.trim();
  if (filePath.includes("\0")) return errorResult("Invalid path.");

  // "--" so a path beginning with "-" is treated as a filename, not a flag
  const shellArgs = ["--", filePath];
  if (args.app && typeof args.app === "string" && args.app.trim()) {
    const appName = args.app.trim();
    if (/[/\\]/.test(appName)) return errorResult("Invalid app name.");
    shellArgs.unshift("-a", appName);
  }

  const r = await runShell("open", shellArgs);
  if (!r.ok) return errorResult(`Failed to open: ${r.error}`);
  return textResult(`Opened: ${filePath}${args.app ? ` in ${args.app}` : ""}`);
};

// ── 18. run_shortcut ────────────────────────────────────────────────────────

HANDLERS["run_shortcut"] = async (args) => {
  if (!["list", "run"].includes(args.action)) {
    return errorResult("Parameter 'action' must be list or run.");
  }

  if (args.action === "list") {
    const r = await runShell("shortcuts", ["list"]);
    if (!r.ok) return errorResult(`Failed to list shortcuts: ${r.error}`);
    const shortcuts = r.stdout.split("\n").filter((s) => s.trim());
    return textResult(JSON.stringify(shortcuts, null, 2));
  }

  if (args.action === "run") {
    if (!args.name || typeof args.name !== "string" || !args.name.trim()) {
      return errorResult("Parameter 'name' is required for run.");
    }
    const shellArgs = ["run", args.name.trim()];
    if (args.input && typeof args.input === "string") {
      shellArgs.push("-i", args.input);
    }
    const r = await runShell("shortcuts", shellArgs, 30000);
    if (!r.ok) return errorResult(`Shortcut failed: ${r.error}`);
    return textResult(r.stdout || "Shortcut completed.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-osascript", version: "1.1.2" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const start = Date.now();
  let status = "ok";
  try {
    if (shuttingDown) return errorResult("Server is shutting down.");
    if (!Object.hasOwn(HANDLERS, name)) {
      status = "error";
      return errorResult(`Unknown tool: ${name}`);
    }
    const result = await HANDLERS[name](args);
    if (result.isError) status = "error";
    return result;
  } catch (err) {
    status = "error";
    return errorResult(`Internal error: ${safeError(err)}`);
  } finally {
    console.error(`[${new Date().toISOString()}] tool=${name} duration=${Date.now() - start}ms status=${status}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("[mcp-osascript] fatal:", err);
  process.exit(1);
});
