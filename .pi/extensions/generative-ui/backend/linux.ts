import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendSupportError, WidgetBackend, WidgetWindow, OpenWindowOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HELPER_PATH = join(__dirname, "../native/linux/bin/pi-generative-ui-linux-helper");
const HELPER_PATH_ENV = "PI_GENERATIVE_UI_LINUX_HELPER_PATH";
const PROBE_TIMEOUT_MS = 4000;

function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function helperError(code: BackendSupportError["code"], reason: string, fixes?: string[]): BackendSupportError {
  return { ok: false, code, reason, fixes };
}

function hasDisplay(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
}

function helperPath(): string {
  const override = process.env[HELPER_PATH_ENV]?.trim();
  return override ? override : DEFAULT_HELPER_PATH;
}

function runtimeFixes(): string[] {
  return [
    "Install a supported GTK/WebKitGTK runtime (Ubuntu 24 / WSL2: sudo apt install -y libgtk-3-0 libwebkit2gtk-4.1-0).",
    isWSL() ? "WSLg must be enabled for native Linux windows on WSL2." : "Run inside a GUI-capable Linux session.",
  ];
}

function displayFixes(): string[] {
  return isWSL()
    ? [
        "Start the distro through Windows Subsystem for Linux with WSLg enabled.",
        "Confirm DISPLAY or WAYLAND_DISPLAY points to a live WSLg server before launching pi.",
        "If DISPLAY is stale, run `wsl --shutdown` from Windows and restart Ubuntu.",
      ]
    : ["Launch pi from a GUI-capable Linux session with DISPLAY or WAYLAND_DISPLAY set."];
}

function displayError(reason: string): BackendSupportError {
  return helperError(isWSL() ? "WSLG_REQUIRED" : "NO_GUI_DISPLAY", reason, displayFixes());
}

function classifyProbeFailure(output: string, code: number | null, signal: NodeJS.Signals | null): BackendSupportError {
  const text = output.trim();
  const lower = text.toLowerCase();

  if (
    lower.includes("gtk could not initialize a gui display") ||
    lower.includes("cannot open display") ||
    lower.includes("wayland") ||
    lower.includes("display")
  ) {
    return displayError(text || "Linux helper could not connect to a GUI display.");
  }

  if (
    lower.includes("webkit") ||
    lower.includes("javascriptcore") ||
    lower.includes("libgtk") ||
    lower.includes("libwebkit") ||
    lower.includes("gtk-")
  ) {
    return helperError(
      "WEBKIT_RUNTIME_MISSING",
      text || "Linux helper self-test failed because the GTK/WebKit runtime is unavailable.",
      runtimeFixes(),
    );
  }

  return helperError(
    "BACKEND_START_FAILED",
    text || `Linux helper self-test failed (code=${code}, signal=${signal}).`,
    runtimeFixes(),
  );
}

async function probeHelperOpen(path: string): Promise<BackendSupportError | { ok: true }> {
  return await new Promise((resolve) => {
    const child = spawn(path, ["--probe-open"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: BackendSupportError | { ok: true }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish(helperError("BACKEND_START_FAILED", `Failed to start Linux helper probe: ${error.message}`, runtimeFixes()));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish({ ok: true as const });
        return;
      }
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      finish(classifyProbeFailure(combined, code, signal));
    });

    const timer = setTimeout(() => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(
        displayError(
          combined ||
            `Linux helper probe did not connect to a GUI display within ${PROBE_TIMEOUT_MS}ms.`,
        ),
      );
    }, PROBE_TIMEOUT_MS);
    timer.unref();
  });
}

class LinuxWidgetWindow extends EventEmitter implements WidgetWindow {
  private child: ChildProcessWithoutNullStreams;
  private closed = false;
  private buffer = "";
  private ready = false;

  constructor(child: ChildProcessWithoutNullStreams, html: string, options: OpenWindowOptions) {
    super();
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        this.handleLine(line);
      }
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (this.closed) return;
      this.emit("error", error);
    });

    child.on("exit", (code, signal) => {
      if (this.closed) return;
      if (this.ready) {
        this.closed = true;
        this.emit("closed");
        return;
      }

      this.closed = true;
      const extra = stderr.trim();
      const detail = extra ? ` ${extra}` : "";
      this.emit("error", new Error(`Linux helper exited before ready (code=${code}, signal=${signal}).${detail}`.trim()));
    });

    this.writeCommand({
      type: "html",
      html,
      title: options.title,
      width: options.width,
      height: options.height,
      floating: options.floating ?? false,
    });
  }

  override on(event: "ready" | "message" | "closed" | "error", handler: (...args: unknown[]) => void): this {
    return super.on(event, handler);
  }

  send(js: string): void {
    if (this.closed) return;
    this.writeCommand({ type: "eval", js });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeCommand({ type: "close" });
    } catch {}
    try {
      this.child.stdin.end();
    } catch {}
    setTimeout(() => {
      if (!this.child.killed) this.child.kill("SIGTERM");
    }, 250).unref();
  }

  private writeCommand(command: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private handleLine(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.close();
      this.emit("error", new Error(`Linux helper emitted malformed JSON: ${line}`));
      return;
    }

    if (message.type === "ready") {
      this.ready = true;
      this.emit("ready");
      return;
    }

    if (message.type === "message") {
      this.emit("message", message.data);
      return;
    }

    if (message.type === "closed") {
      if (this.closed) return;
      this.closed = true;
      this.emit("closed");
      return;
    }

    if (message.type === "error") {
      this.closed = true;
      this.emit("error", new Error(`${message.code ?? "BACKEND_START_FAILED"}: ${message.message ?? "Unknown helper error"}`));
      try { this.child.kill("SIGTERM"); } catch {}
      return;
    }
  }
}

export class LinuxWebviewBackend implements WidgetBackend {
  kind = "linux-webview" as const;

  async checkSupport() {
    if (process.platform !== "linux") {
      return helperError("UNSUPPORTED_PLATFORM", `Platform ${process.platform} is not supported by the Linux webview backend.`);
    }

    const path = helperPath();

    if (!existsSync(path)) {
      return helperError(
        "BACKEND_BINARY_MISSING",
        `Missing Linux helper binary at ${path}.`,
        [
          `Run npm install so postinstall builds the Linux helper binary at ${DEFAULT_HELPER_PATH}.`,
          `Set ${HELPER_PATH_ENV} only when intentionally overriding the helper path.`,
        ],
      );
    }

    try {
      accessSync(path, constants.X_OK);
    } catch {
      return helperError(
        "BACKEND_BINARY_NOT_EXECUTABLE",
        `Linux helper binary is not executable: ${path}.`,
        ["Run chmod +x on the helper or rerun npm install to rebuild it."],
      );
    }

    if (!hasDisplay()) {
      return displayError(
        isWSL()
          ? "WSLg is required to open native widget windows on the supported WSL2 path, but neither DISPLAY nor WAYLAND_DISPLAY is set."
          : "No GUI display is available because neither DISPLAY nor WAYLAND_DISPLAY is set.",
      );
    }

    return await probeHelperOpen(path);
  }

  async open(html: string, options: OpenWindowOptions): Promise<WidgetWindow> {
    const child = spawn(helperPath(), [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return new LinuxWidgetWindow(child, html, options);
  }
}

export function linuxHelperPath() {
  return helperPath();
}
