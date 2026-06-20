import { spawn } from "child_process";

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

  // Strip filesystem paths
  msg = msg.replace(
    /(?:\/Users|\/var|\/private|\/tmp|\/opt|\/etc|\/Applications|\/Library|\/System|\/Volumes)\/[^\s'",;)}\]>]*/g,
    "<path>"
  );

  // Strip Bearer tokens
  msg = msg.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer <redacted>");

  // Strip password= or token= values
  msg = msg.replace(
    /(password|token|secret|api_key|apikey)[\s]*[=:]\s*["']?[^\s"',;)}\]>]+/gi,
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
    const app = appMatch ? appMatch[1] : "the target app";
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

  const effectiveTimeout = Math.min(
    Math.max(timeoutMs, 1000),
    MAX_TIMEOUT
  );

  await semaphore.acquire();

  try {
    return await new Promise((resolve, reject) => {
      const args = [];
      if (language === "javascript") {
        args.push("-l", "JavaScript");
      }
      // Read from stdin
      args.push("-");

      const child = spawn("/usr/bin/osascript", args, {
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
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
          timedOut,
        });
      };

      // Timeout handling
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
        }, KILL_GRACE_MS);
      }, effectiveTimeout);

      child.stdout.on("data", (chunk) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
          stdout += chunk.slice(0, remaining).toString();
        }
        stdoutBytes += chunk.length;
      });

      child.stderr.on("data", (chunk) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderrBytes;
          stderr += chunk.slice(0, remaining).toString();
        }
        stderrBytes += chunk.length;
      });

      child.on("close", (code) => {
        finish(code);
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      // Write script to stdin and close
      child.stdin.write(script);
      child.stdin.end();
    });
  } finally {
    semaphore.release();
  }
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
