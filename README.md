# mcp-osascript

MCP server for macOS automation via AppleScript and JXA (JavaScript for Automation).

I couldn't find a solid, production-quality osascript MCP connector in the open source ecosystem — everything out there was either a barebones single-tool wrapper or a bloated recipe collection with no safety guardrails. So I built my own.

## What it does

12 typed tools that cover the most common macOS automation needs — from clipboard and notifications to window management and app menu interaction. Plus a generic `run_osascript` escape hatch for anything else.

| Tool | Description | Permission |
|------|-------------|------------|
| `run_osascript` | Execute arbitrary AppleScript or JXA | None |
| `get_clipboard` | Read clipboard as text | None |
| `set_clipboard` | Write text to clipboard | None |
| `send_notification` | Show macOS notification banner | None |
| `open_url` | Open URL in default browser (http/https/mailto only) | None |
| `open_app` | Launch or activate an application | None |
| `get_frontmost_app` | Get active app name and bundle ID | None |
| `get_browser_tabs` | List tabs in Safari, Chrome, or Arc | Automation |
| `type_text` | Type text into active app (max 500 chars) | Accessibility |
| `press_key` | Press key with modifiers (cmd+c, return, etc.) | Accessibility |
| `manage_windows` | List, move, resize, minimize, fullscreen, close windows | Accessibility |
| `app_menu` | List or click application menu items | Accessibility |

## Installation

```bash
git clone https://github.com/morvayne1/mcp-osascript.git
cd mcp-osascript
npm install
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "osascript": {
      "command": "node",
      "args": ["/path/to/mcp-osascript/server/index.js"]
    }
  }
}
```

### Via npx (no clone needed)

```json
{
  "mcpServers": {
    "osascript": {
      "command": "npx",
      "args": ["-y", "mcp-osascript"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add osascript -- node /path/to/mcp-osascript/server/index.js
```

## Permissions

Tools are split into three tiers:

- **No permission needed** — clipboard, notifications, URLs, apps. Works out of the box.
- **Automation** — browser tabs. macOS will prompt to allow control of each browser.
- **Accessibility** — keyboard input, window management, menus. Grant in **System Settings → Privacy & Security → Accessibility**.

When a permission is missing, the server returns a clear error with the exact System Settings path to fix it.

## Design decisions

- **Stdin piping** — scripts are piped via stdin to `/usr/bin/osascript`. No temp files, no TOCTOU race conditions.
- **Process group kill** — on timeout, the entire process group is killed (SIGTERM → 2s grace → SIGKILL). No orphaned child processes.
- **URL scheme allowlist** — `open_url` only allows `http:`, `https:`, `mailto:`. No `file://`, `smb://`, `vnc://`, etc.
- **Concurrency control** — semaphore limits to 5 simultaneous osascript processes.
- **Friendly errors** — AppleScript error codes (-1728, -1743, -25211, etc.) are parsed into human-readable messages with remediation steps. Supports English and Russian macOS locales.
- **Self-correcting menus** — when `app_menu click` fails, the server returns a list of available menu items at that level so the LLM can retry with the correct name.

## Testing

```bash
npm test
```

Runs 41 integration tests covering all 12 tools, input validation, security boundaries (URL scheme blocking, prototype pollution, script size limits), timeout enforcement, and permission error handling.

## Security

- `run_osascript` executes arbitrary code — this is by design. The MCP client (Claude) is the trust boundary.
- Script size: 50 KB max.
- Output: 50K chars max (truncated).
- Error messages are sanitized — filesystem paths, tokens, and passwords are stripped.
- All handler dispatch uses `Object.create(null)` — no prototype pollution.

## Requirements

- macOS 13+ (Ventura or later)
- Node.js 18+

## License

MIT
