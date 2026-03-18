import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackendSupportError, WidgetBackend } from "./types.js";

const requireFromHere = createRequire(import.meta.url);

let glimpseModule: { open: (html: string, options: Record<string, unknown>) => any } | null = null;

function getRuntimePlatform() {
  return process.env.PI_GENERATIVE_UI_TEST_PLATFORM || process.platform;
}

function isWSL(): boolean {
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

function isMissingGlimpseDependency(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot find module") && message.includes("glimpseui");
}

async function getGlimpse(modulePath = resolveGlimpseModulePath()): Promise<{ open: (html: string, options: Record<string, unknown>) => any }> {
  if (!glimpseModule) {
    glimpseModule = await import(pathToFileURL(modulePath).href) as { open: (html: string, options: Record<string, unknown>) => any };
  }
  return glimpseModule;
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
      return supportError(
        isWSL() ? "WSLG_REQUIRED" : "NO_GUI_DISPLAY",
        isWSL()
          ? "WSLg is required to open native Glimpse windows on the supported WSL2 path, but neither DISPLAY nor WAYLAND_DISPLAY is set."
          : "No GUI display is available because neither DISPLAY nor WAYLAND_DISPLAY is set.",
        displayFixes(),
      );
    }

    let modulePath: string;
    try {
      modulePath = resolveGlimpseModulePath();
    } catch (error) {
      return supportError(
        "BACKEND_BINARY_MISSING",
        isMissingGlimpseDependency(error)
          ? "The upstream 'glimpseui' dependency is not installed or could not be resolved from this package."
          : (error instanceof Error ? error.message : String(error)),
        [
          "Run npm install so the upstream glimpseui dependency is available for this package.",
          ...glimpseBuildFixes(platform),
        ],
      );
    }

    const hostPath = resolveGlimpseHostPath(modulePath);
    if (!existsSync(hostPath)) {
      const skippedBuildReason = readSkippedBuildReason(modulePath);
      return supportError(
        "BACKEND_BINARY_MISSING",
        skippedBuildReason
          ? `Missing upstream Glimpse host at ${hostPath}. ${skippedBuildReason}`
          : `Missing upstream Glimpse host at ${hostPath}.`,
        glimpseBuildFixes(platform),
      );
    }

    try {
      accessSync(hostPath, constants.X_OK);
    } catch {
      return supportError(
        "BACKEND_BINARY_NOT_EXECUTABLE",
        `Upstream Glimpse host is not executable: ${hostPath}.`,
        glimpseBuildFixes(platform),
      );
    }

    try {
      await getGlimpse(modulePath);
      return { ok: true as const };
    } catch (error) {
      return supportError(
        "BACKEND_START_FAILED",
        error instanceof Error ? error.message : String(error),
        glimpseBuildFixes(platform),
      );
    }
  }

  async open(html: string, options: { width: number; height: number; title: string; floating?: boolean }) {
    const { open } = await getGlimpse();
    return open(html, options);
  }
}
