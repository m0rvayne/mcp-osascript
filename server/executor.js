import { spawn } from "child_process";
import { StringDecoder } from "node:string_decoder";

// Constants
export const MAX_CONCURRENT = 5;
export const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB — textResult truncates at 50K chars, no need for 1 MB
export const DEFAULT_TIMEOUT = 30000;
export const MAX_TIMEOUT = 120000;
export const MAX_SCRIPT_LENGTH = 50000;
const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------
class Semaphore {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this._active < this._max) {
        this._active++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._active = Math.max(0, this._active - 1);
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// Safe error sanitization
// ---------------------------------------------------------------------------
export function safeError(error) {
  let msg = typeof error === "string" ? error : String(error ?? "");

  // Structured secrets first — these are recognisable on their own and must be
  // removed before the looser key=value rule gets a chance to mangle them.
  msg = msg.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "<private-key>");
  msg = msg.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "<jwt>"
  );
  msg = msg.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<aws-key-id>");
  msg = msg.replace(
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
    "<github-token>"
  );
  msg = msg.replace(/\bnpm_[A-Za-z0-9]{30,}/g, "<npm-token>");
  msg = msg.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<slack-token>");
  msg = msg.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "<api-key>");
  msg = msg.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer <redacted>");

  // Credentials embedded in a URL: scheme://user:pass@host
  msg = msg.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//<redacted>@");

  // POSIX paths
  msg = msg.replace(
    /(?:\/Users|\/home|\/var|\/private|\/tmp|\/opt|\/etc|\/usr|\/Applications|\/Library|\/System|\/Volumes)\/[^\s'",;)}\]>]*/g,
    "<path>"
  );
  // ~/... and HFS colon paths ("Macintosh HD:Users:name:..."), which osascript
  // emits routinely and the POSIX rule above cannot see.
  msg = msg.replace(/~\/[^\s'",;)}\]>]*/g, "<path>");
  msg = msg.replace(/\b[A-Za-z][\w ]*:Users:[^\s'"]*/g, "<path>");
  msg = msg.replace(/\bUsers:[^\s'"]*/g, "<path>");

  // Username in environment form
  msg = msg.replace(/\b(USER|LOGNAME|USERNAME)=\S+/g, "$1=<redacted>");

  // key=value / "key": "value" — the separator may be preceded by a closing
  // quote (JSON) and the key may carry affixes (AWS_SECRET_ACCESS_KEY).
  msg = msg.replace(
    /([A-Za-z_]*(?:password|passwd|token|secret|api[_-]?key|apikey|credential)[A-Za-z_]*)["']?\s*[=:]\s*["']?[^\s"',;)}\]>]+/gi,
    "$1=<redacted>"
  );

  return msg;
}

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------
export function classifyError(stderr, exitCode, timedOut = false) {
  const s = (stderr ?? "").toLowerCase();

  if (timedOut) {
    return {
      code: "TIMEOUT",
      category: "timeout",
      friendlyMessage: `Script exceeded timeout`,
      remediation: "Reduce script complexity or increase the timeout parameter.",
    };
  }

  if (
    s.includes("not allowed assistive access") ||
    s.includes("not allowed to send keystrokes") ||
    s.includes("не разрешен") ||
    s.includes("-25211") ||
    s.includes("-1719") ||
    (s.includes("-1728") && s.includes("assistive"))
  ) {
    return {
      code: "ERR_ACCESSIBILITY",
      category: "permission_accessibility",
      friendlyMessage:
        "Accessibility permission required. Grant access in System Settings > Privacy & Security > Accessibility.",
      remediation:
        "Open System Settings > Privacy & Security > Accessibility and add/enable the calling application.",
    };
  }

  if (s.includes("-1743")) {
    const appMatch = (stderr ?? "").match(
      /application (?:process )?["""]?(.+?)["""]?(?:\.|$)/i
    );
    const app = appMatch ? safeError(appMatch[1]) : "the target app";
    return {
      code: "ERR_AUTOMATION",
      category: "permission_automation",
      friendlyMessage: `Grant Automation permission for ${app} in System Settings > Privacy & Security > Automation`,
      remediation: `Open System Settings > Privacy & Security > Automation and allow the calling application to control ${app}.`,
    };
  }

  if (s.includes("syntax error")) {
    return {
      code: "ERR_SYNTAX",
      category: "syntax",
      friendlyMessage:
        "AppleScript syntax error — check quotes and 'end tell' blocks",
      remediation:
        "Review the script for unmatched quotes, missing 'end tell', or invalid keywords.",
    };
  }

  if (s.includes("application isn't running") || s.includes("-600")) {
    return {
      code: "ERR_APP_NOT_RUNNING",
      category: "app_not_running",
      friendlyMessage:
        "Application is not running. Use open_app to launch it first.",
      remediation: "Launch the target application before running the script.",
    };
  }

  if (s.includes("can't get application") || s.includes("-2741")) {
    return {
      code: "ERR_APP_NOT_FOUND",
      category: "app_not_found",
      friendlyMessage: "Application not found or not scriptable",
      remediation:
        "Verify the application name is correct and that it supports AppleScript/JXA.",
    };
  }

  if (s.includes("-128")) {
    return {
      code: "ERR_USER_CANCELLED",
      category: "user_cancelled",
      friendlyMessage: "User cancelled the action",
      remediation: "The user dismissed a dialog or cancelled the operation.",
    };
  }

  return {
    code: "ERR_UNKNOWN",
    category: "unknown",
    friendlyMessage: safeError(stderr || `Script exited with code ${exitCode}`),
    remediation: "Check the stderr output for details.",
  };
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------
/**
 * Spawn a child in its own process group, feed it optional stdin, and guarantee
 * the promise settles: on timeout we escalate SIGTERM -> SIGKILL across the
 * whole group and then force-resolve, because "close" waits for the stdio pipes
 * to drain and a grandchild that escaped the group can hold them open forever.
 * Every caller goes through the shared semaphore.
 */
async function spawnGuarded(command, args, stdinData, timeoutMs) {
  const effectiveTimeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT);

  await semaphore.acquire();

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: process.env.HOME || "/tmp",
          LANG: "en_US.UTF-8",
        },
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
      };

      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // process may have already exited
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // process may have already exited
          }
          // See the doc comment: settle even if the pipes never close.
          try { child.stdout.destroy(); } catch { /* already gone */ }
          try { child.stderr.destroy(); } catch { /* already gone */ }
          finish(null);
        }, KILL_GRACE_MS);
      }, effectiveTimeout);

      // Decoders hold incomplete multi-byte sequences between chunks, so a UTF-8
      // character split across a chunk (or cut off by the output cap) is never
      // turned into U+FFFD — the dangling bytes are simply dropped.
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");

      child.stdout.on("data", (chunk) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
          stdout += outDecoder.write(
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
          );
        }
        stdoutBytes += chunk.length;
      });

      child.stderr.on("data", (chunk) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderrBytes;
          stderr += errDecoder.write(
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
          );
        }
        stderrBytes += chunk.length;
      });

      child.on("close", (code) => finish(code));

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          reject(err);
        }
      });

      if (stdinData !== null) {
        child.stdin.write(stdinData);
      }
      child.stdin.end();
    });
  } finally {
    semaphore.release();
  }
}

export async function executeScript(
  script,
  language = "applescript",
  timeoutMs = DEFAULT_TIMEOUT
) {
  if (!script || typeof script !== "string") {
    throw new Error("script must be a non-empty string");
  }
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Script length ${script.length} exceeds maximum of ${MAX_SCRIPT_LENGTH} characters`
    );
  }

  const args = [];
  if (language === "javascript") {
    args.push("-l", "JavaScript");
  }
  args.push("-"); // read the script from stdin

  return spawnGuarded("/usr/bin/osascript", args, script, timeoutMs);
}

/**
 * Run a plain command (no shell, argv array) with the same guarantees as
 * executeScript: process-group kill on timeout and shared concurrency limit.
 */
export async function executeCommand(command, args, timeoutMs = DEFAULT_TIMEOUT) {
  if (typeof command !== "string" || !command) {
    throw new Error("command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new Error("args must be an array of strings");
  }
  return spawnGuarded(command, args, null, timeoutMs);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------
export async function executeAppleScript(script, timeoutMs = DEFAULT_TIMEOUT) {
  return executeScript(script, "applescript", timeoutMs);
}

export async function executeJXA(script, timeoutMs = DEFAULT_TIMEOUT) {
  return executeScript(script, "javascript", timeoutMs);
}
