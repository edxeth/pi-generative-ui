import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { formatSupportError } from "./errors.js";
import type { BackendSupportError, BackendSupportOk, WidgetBackend } from "./types.js";

const requireFromHere = createRequire(import.meta.url);
const PROBE_TIMEOUT_MS = 4000;

let glimpseModule: { open: (html: string, options: Record<string, unknown>) => any } | null = null;
let glimpseModulePath: string | null = null;

function getRuntimePlatform() {
  return process.env.PI_GENERATIVE_UI_TEST_PLATFORM || process.platform;
}

function isWSL(): boolean {
  const override = process.env.PI_GENERATIVE_UI_TEST_WSL;
  if (override === "1") return true;
  if (override === "0") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function hasDisplay(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
}

function supportError(code: BackendSupportError["code"], reason: string, fixes?: string[]): BackendSupportError {
  return { ok: false, code, reason, fixes };
}

function displayFixes(): string[] {
  return isWSL()
    ? [
        "Start the distro through WSL2 with WSLg enabled.",
        "Confirm DISPLAY or WAYLAND_DISPLAY points to a live WSLg server before launching pi.",
        "If the display variables are stale, run `wsl --shutdown` from Windows and restart Ubuntu.",
      ]
    : ["Launch pi from a GUI-capable Linux session with DISPLAY or WAYLAND_DISPLAY set."];
}

function glimpseBuildFixes(platform: string): string[] {
  if (platform === "linux") {
    return [
      "Install Rust from https://rustup.rs so upstream Glimpse can build its Linux host.",
      "Install the GTK4/WebKitGTK 6 development packages required by upstream Glimpse, then rerun npm install or npm run build:linux inside node_modules/glimpseui.",
      isWSL() ? "WSLg must be enabled for the supported WSL2 Linux GUI path." : "Run inside a GUI-capable Linux session.",
    ];
  }

  return [
    "Run npm install on a supported Glimpse platform so the upstream native host is available.",
    "If the Glimpse host build was skipped, rerun the platform-specific Glimpse build command inside node_modules/glimpseui.",
  ];
}

function resolveGlimpseModulePath(): string {
  const override = process.env.PI_GENERATIVE_UI_GLIMPSE_MODULE;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return requireFromHere.resolve("glimpseui");
}

function resolveGlimpsePackageRoot(modulePath: string): string {
  return dirname(dirname(modulePath));
}

function resolveGlimpseHostPath(modulePath: string): string {
  const override = process.env.GLIMPSE_BINARY_PATH || process.env.GLIMPSE_HOST_PATH;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return join(resolveGlimpsePackageRoot(modulePath), "src", "glimpse");
}

function readSkippedBuildReason(modulePath: string): string | null {
  const skippedBuildPath = join(resolveGlimpsePackageRoot(modulePath), ".glimpse-build-skipped");
  if (!existsSync(skippedBuildPath)) return null;
  return readFileSync(skippedBuildPath, "utf8").trim() || null;
}

function missingDependencyFixes(platform: string): string[] {
  return [
    "Run npm install so the upstream glimpseui dependency is available for this package.",
    ...glimpseBuildFixes(platform),
  ];
}

function displayError(reason: string): BackendSupportError {
  return supportError(
    isWSL() ? "WSLG_REQUIRED" : "NO_GUI_DISPLAY",
    reason,
    displayFixes(),
  );
}

function normalizeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

function isDisplayFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("gtk could not initialize a gui display")
    || lower.includes("cannot open display")
    || lower.includes("failed to open display")
    || lower.includes("display server")
    || lower.includes("wayland display")
  );
}

function isRuntimeDependencyFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("webkit")
    || lower.includes("javascriptcore")
    || lower.includes("libwebkit")
    || lower.includes("libgtk")
    || lower.includes("gtk4")
    || lower.includes("gtk-")
    || lower.includes("libadwaita")
    || lower.includes("shared libraries")
  );
}

function isMissingModuleFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes("cannot find module") || lower.includes("err_module_not_found"))
    && lower.includes("glimpse")
  );
}

function isMissingHostFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("glimpse host not found")
    || lower.includes("enoent")
    || lower.includes("no such file or directory")
  );
}

function isNotExecutableFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("eacces")
    || lower.includes("permission denied")
    || lower.includes("not executable")
  );
}

function missingModuleError(platform: string, modulePath: string): BackendSupportError {
  return supportError(
    "BACKEND_BINARY_MISSING",
    `The upstream 'glimpseui' dependency could not be loaded from ${modulePath}.`,
    missingDependencyFixes(platform),
  );
}

function missingHostError(platform: string, hostPath: string, skippedBuildReason?: string | null): BackendSupportError {
  return supportError(
    "BACKEND_BINARY_MISSING",
    skippedBuildReason
      ? `Missing upstream Glimpse host at ${hostPath}. ${skippedBuildReason}`
      : `Missing upstream Glimpse host at ${hostPath}.`,
    glimpseBuildFixes(platform),
  );
}

function notExecutableHostError(platform: string, hostPath: string): BackendSupportError {
  return supportError(
    "BACKEND_BINARY_NOT_EXECUTABLE",
    `Upstream Glimpse host is not executable: ${hostPath}.`,
    glimpseBuildFixes(platform),
  );
}

function normalizeGlimpseFailure(
  platform: string,
  error: unknown,
  options: { modulePath?: string; hostPath?: string; skippedBuildReason?: string | null } = {},
): BackendSupportError {
  const message = normalizeErrorMessage(error);

  if (platform === "linux" && isDisplayFailure(message)) {
    return displayError(message || "Upstream Glimpse could not connect to a GUI display.");
  }

  if (
    (options.modulePath && !existsSync(options.modulePath))
    || isMissingModuleFailure(message)
    || (options.modulePath != null && message.includes(options.modulePath) && (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")))
  ) {
    return missingModuleError(platform, options.modulePath ?? "glimpseui");
  }

  if ((options.hostPath && !existsSync(options.hostPath)) || isMissingHostFailure(message)) {
    return missingHostError(platform, options.hostPath ?? "glimpse host", options.skippedBuildReason);
  }

  if (isNotExecutableFailure(message)) {
    return notExecutableHostError(platform, options.hostPath ?? "glimpse host");
  }

  if (platform === "linux" && isRuntimeDependencyFailure(message)) {
    return supportError(
      "WEBKIT_RUNTIME_MISSING",
      message || "Upstream Glimpse failed because the GTK/WebKit runtime is unavailable.",
      glimpseBuildFixes(platform),
    );
  }

  return supportError(
    "BACKEND_START_FAILED",
    message || "Upstream Glimpse failed to start.",
    glimpseBuildFixes(platform),
  );
}

async function getGlimpse(modulePath = resolveGlimpseModulePath()): Promise<{ open: (html: string, options: Record<string, unknown>) => any }> {
  if (!glimpseModule || glimpseModulePath !== modulePath) {
    glimpseModule = await import(pathToFileURL(modulePath).href) as { open: (html: string, options: Record<string, unknown>) => any };
    glimpseModulePath = modulePath;
  }
  return glimpseModule;
}

async function probeLinuxHost(hostPath: string): Promise<BackendSupportOk | BackendSupportError> {
  return await new Promise((resolve) => {
    const child = spawn(hostPath, [
      "--hidden",
      "--width", "1",
      "--height", "1",
      "--title", "pi-generative-ui support probe",
    ], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let sawReady = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const finish = (result: BackendSupportOk | BackendSupportError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(result);
    };

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      stdout += `${line}\n`;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        finish(normalizeGlimpseFailure("linux", `Malformed Glimpse probe output: ${line}`, { hostPath }));
        return;
      }

      if (msg?.type === "ready") {
        sawReady = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        finish({ ok: true as const });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      finish(normalizeGlimpseFailure("linux", error, { hostPath }));
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      if (sawReady || code === 0) {
        finish({ ok: true as const });
        return;
      }

      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      finish(
        normalizeGlimpseFailure(
          "linux",
          combined || `Upstream Glimpse support probe failed (code=${code}, signal=${signal}).`,
          { hostPath },
        ),
      );
    });

    const timer = setTimeout(() => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(
        normalizeGlimpseFailure(
          "linux",
          combined || `Upstream Glimpse support probe did not become ready within ${PROBE_TIMEOUT_MS}ms.`,
          { hostPath },
        ),
      );
    }, PROBE_TIMEOUT_MS);
  });
}

export class GlimpseBackend implements WidgetBackend {
  kind = "glimpse" as const;

  async checkSupport() {
    const platform = getRuntimePlatform();
    if (platform !== "darwin" && platform !== "linux") {
      return supportError(
        "UNSUPPORTED_PLATFORM",
        `Platform ${platform} is not supported by the Glimpse backend.`,
      );
    }

    if (platform === "linux" && !hasDisplay()) {
      return displayError(
        isWSL()
          ? "WSLg is required to open native Glimpse windows on the supported WSL2 path, but neither DISPLAY nor WAYLAND_DISPLAY is set."
          : "No GUI display is available because neither DISPLAY nor WAYLAND_DISPLAY is set.",
      );
    }

    let modulePath: string;
    try {
      modulePath = resolveGlimpseModulePath();
    } catch (error) {
      return normalizeGlimpseFailure(platform, error, {});
    }

    if (!existsSync(modulePath)) {
      return missingModuleError(platform, modulePath);
    }

    const hostPath = resolveGlimpseHostPath(modulePath);
    const skippedBuildReason = readSkippedBuildReason(modulePath);
    if (!existsSync(hostPath)) {
      return missingHostError(platform, hostPath, skippedBuildReason);
    }

    try {
      accessSync(hostPath, constants.X_OK);
    } catch {
      return notExecutableHostError(platform, hostPath);
    }

    try {
      await getGlimpse(modulePath);
    } catch (error) {
      return normalizeGlimpseFailure(platform, error, { modulePath, hostPath, skippedBuildReason });
    }

    if (platform === "linux") {
      return await probeLinuxHost(hostPath);
    }

    return { ok: true as const };
  }

  async open(html: string, options: { width: number; height: number; title: string; floating?: boolean }) {
    const platform = getRuntimePlatform();
    const modulePath = resolveGlimpseModulePath();
    const hostPath = existsSync(modulePath) ? resolveGlimpseHostPath(modulePath) : undefined;
    const skippedBuildReason = existsSync(modulePath) ? readSkippedBuildReason(modulePath) : null;

    try {
      const { open } = await getGlimpse(modulePath);
      return open(html, options);
    } catch (error) {
      throw new Error(formatSupportError(this.kind, normalizeGlimpseFailure(platform, error, {
        modulePath,
        hostPath,
        skippedBuildReason,
      })));
    }
  }
}
