import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendSupportError, WidgetBackend, WidgetWindow, OpenWindowOptions } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(__dirname, "../native/linux/bin/pi-generative-ui-linux-helper");

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

function shellQuote(value: string): string {
  return JSON.stringify(value);
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

    if (!existsSync(HELPER_PATH)) {
      return helperError(
        "BACKEND_BINARY_MISSING",
        `Missing Linux helper binary at ${HELPER_PATH}.`,
        ["Run npm install so postinstall builds the Linux helper binary."],
      );
    }

    try {
      accessSync(HELPER_PATH, constants.X_OK);
    } catch {
      return helperError(
        "BACKEND_BINARY_NOT_EXECUTABLE",
        `Linux helper binary is not executable: ${HELPER_PATH}.`,
        ["Run chmod +x on the helper or rerun npm install to rebuild it."],
      );
    }

    if (!hasDisplay()) {
      return helperError(
        isWSL() ? "WSLG_REQUIRED" : "NO_GUI_DISPLAY",
        isWSL()
          ? "WSLg is required to open native widget windows on the supported WSL2 path, but neither DISPLAY nor WAYLAND_DISPLAY is set."
          : "No GUI display is available because neither DISPLAY nor WAYLAND_DISPLAY is set.",
        isWSL()
          ? [
              "Start the distro through Windows Subsystem for Linux with WSLg enabled.",
              "Confirm DISPLAY or WAYLAND_DISPLAY is set inside the shell before launching pi.",
            ]
          : ["Launch pi from a GUI-capable Linux session with DISPLAY or WAYLAND_DISPLAY set."],
      );
    }

    const probe = spawnSync(HELPER_PATH, ["--probe-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    if (probe.status !== 0) {
      const combined = [probe.stdout, probe.stderr].filter(Boolean).join("\n").trim();
      return helperError(
        /webkit|gtk/i.test(combined) ? "WEBKIT_RUNTIME_MISSING" : "BACKEND_START_FAILED",
        combined || "Linux helper self-test failed.",
        [
          "Install a supported GTK/WebKitGTK runtime (Ubuntu 24 / WSL2: sudo apt install -y libgtk-3-0 libwebkit2gtk-4.1-0).",
          isWSL() ? "WSLg must be enabled for native Linux windows on WSL2." : "Run inside a GUI-capable Linux session.",
        ],
      );
    }

    return { ok: true as const };
  }

  async open(html: string, options: OpenWindowOptions): Promise<WidgetWindow> {
    const child = spawn(HELPER_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return new LinuxWidgetWindow(child, html, options);
  }
}

export function linuxHelperPath() {
  return HELPER_PATH;
}
