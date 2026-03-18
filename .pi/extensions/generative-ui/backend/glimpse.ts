import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { formatSupportError } from "./errors.js";
import type { BackendSupportError, BackendSupportOk, WidgetBackend } from "./types.js";

const requireFromHere = createRequire(import.meta.url);
const PROBE_TIMEOUT_MS = 4000;
const LINUX_GTK4_LAYER_SHELL_PKG_CONFIG = "gtk4-layer-shell-0";
const UBUNTU_GTK4_LAYER_SHELL_PACKAGE = "libgtk4-layer-shell-dev";
const UBUNTU_GTK3_LAYER_SHELL_PACKAGE = "libgtk-layer-shell-dev";
const LINUX_BUILD_DEPS = [
  { pkgConfig: "gtk4", ubuntu: "libgtk-4-dev", fedora: "gtk4-devel", arch: "gtk4" },
  { pkgConfig: "webkitgtk-6.0", ubuntu: "libwebkitgtk-6.0-dev", fedora: "webkitgtk6.0-devel", arch: "webkitgtk-6.0" },
  { pkgConfig: LINUX_GTK4_LAYER_SHELL_PKG_CONFIG, ubuntu: UBUNTU_GTK4_LAYER_SHELL_PACKAGE, fedora: "gtk4-layer-shell-devel", arch: "gtk4-layer-shell" },
] as const;

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

function commandAvailable(command: string, args: string[] = ["--version"]): boolean {
  const override = process.env[`PI_GENERATIVE_UI_TEST_COMMAND_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (override === "1") return true;
  if (override === "0") return false;
  const result = spawnSync(command, args, { stdio: "pipe", env: process.env });
  return !result.error && result.status === 0;
}

function isUbuntuLike(): boolean {
  const override = process.env.PI_GENERATIVE_UI_TEST_UBUNTU_LIKE;
  if (override === "1") return true;
  if (override === "0") return false;
  try {
    return /(^|\n)(ID|ID_LIKE)=.*ubuntu/i.test(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return false;
  }
}

function aptPackageHasCandidate(pkg: string): boolean | null {
  if (!isUbuntuLike() || !commandAvailable("apt-cache")) {
    return null;
  }

  const result = spawnSync("apt-cache", ["show", pkg], { stdio: "pipe", env: process.env, encoding: "utf8" });
  if (result.error) {
    return null;
  }

  return Boolean((result.stdout ?? "").trim());
}

function ubuntuLayerShellRepoState(): "gtk4" | "gtk3-only" | "missing" | "unknown" | null {
  const override = process.env.PI_GENERATIVE_UI_TEST_UBUNTU_LAYER_SHELL_STATE;
  if (override === "gtk4" || override === "gtk3-only" || override === "missing" || override === "unknown") {
    return override;
  }

  const gtk4Candidate = aptPackageHasCandidate(UBUNTU_GTK4_LAYER_SHELL_PACKAGE);
  const gtk3Candidate = aptPackageHasCandidate(UBUNTU_GTK3_LAYER_SHELL_PACKAGE);

  if (gtk4Candidate === true) return "gtk4";
  if (gtk4Candidate === false && gtk3Candidate === true) return "gtk3-only";
  if (gtk4Candidate === false && gtk3Candidate === false) return "missing";
  if (gtk4Candidate == null && gtk3Candidate == null) return null;
  return "unknown";
}

function missingLinuxBuildDeps() {
  const override = process.env.PI_GENERATIVE_UI_TEST_MISSING_LINUX_PKG_CONFIG;
  if (override != null) {
    const missing = new Set(override.split(",").map((value) => value.trim()).filter(Boolean));
    return LINUX_BUILD_DEPS.filter((dep) => missing.has(dep.pkgConfig));
  }

  if (!commandAvailable("pkg-config")) {
    return [...LINUX_BUILD_DEPS];
  }

  return LINUX_BUILD_DEPS.filter((dep) => {
    const result = spawnSync("pkg-config", ["--exists", dep.pkgConfig], { stdio: "pipe", env: process.env });
    return result.status !== 0;
  });
}

function detectedLegacyLinuxRuntimePackages(): string[] {
  const override = process.env.PI_GENERATIVE_UI_TEST_LEGACY_LINUX_RUNTIME;
  if (override != null) {
    return override.split(",").map((value) => value.trim()).filter(Boolean);
  }

  const result = spawnSync("ldconfig", ["-p"], { stdio: "pipe", env: process.env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const detected: string[] = [];
  if (output.includes("libwebkit2gtk-4.1.so")) detected.push("WebKitGTK 4.1");
  if (output.includes("libjavascriptcoregtk-4.1.so")) detected.push("JavaScriptCoreGTK 4.1");
  return detected;
}

function legacyLinuxRuntimeNote(missingDeps = missingLinuxBuildDeps()): string | null {
  if (!missingDeps.some((dep) => dep.pkgConfig === "webkitgtk-6.0")) {
    return null;
  }

  const detected = detectedLegacyLinuxRuntimePackages();
  if (detected.length === 0) {
    return null;
  }

  return `Detected legacy ${detected.join(" + ")} runtime libraries from the old helper-era stack, but upstream Glimpse requires WebKitGTK 6.0 instead.`;
}

function ubuntuLinuxBuildPackages(missingDeps = missingLinuxBuildDeps()): string[] {
  const layerShellState = ubuntuLayerShellRepoState();
  return [...new Set(missingDeps.flatMap((dep) => {
    if (dep.pkgConfig !== LINUX_GTK4_LAYER_SHELL_PKG_CONFIG) {
      return dep.ubuntu;
    }

    if (layerShellState === "gtk4") {
      return dep.ubuntu;
    }

    return [];
  }))];
}

function linuxLayerShellRepoNote(missingDeps = missingLinuxBuildDeps()): string | null {
  if (!missingDeps.some((dep) => dep.pkgConfig === LINUX_GTK4_LAYER_SHELL_PKG_CONFIG)) {
    return null;
  }

  const layerShellState = ubuntuLayerShellRepoState();
  if (layerShellState === "gtk3-only") {
    return `Ubuntu 24 apt exposes only ${UBUNTU_GTK3_LAYER_SHELL_PACKAGE} (GTK3 / gtk-layer-shell-0); it does not satisfy upstream Glimpse's GTK4 layer-shell requirement (${LINUX_GTK4_LAYER_SHELL_PKG_CONFIG}).`;
  }

  if (layerShellState === "missing") {
    return `Ubuntu 24 apt does not expose a ${UBUNTU_GTK4_LAYER_SHELL_PACKAGE} package for ${LINUX_GTK4_LAYER_SHELL_PKG_CONFIG} in this environment.`;
  }

  return null;
}

function linuxLayerShellRepoFix(missingDeps = missingLinuxBuildDeps()): string | null {
  if (!missingDeps.some((dep) => dep.pkgConfig === LINUX_GTK4_LAYER_SHELL_PKG_CONFIG)) {
    return null;
  }

  const layerShellState = ubuntuLayerShellRepoState();
  if (layerShellState === "gtk3-only" || layerShellState === "missing") {
    return `Ubuntu 24 / WSL2 cannot satisfy ${LINUX_GTK4_LAYER_SHELL_PKG_CONFIG} from the default apt repos in this environment. Use a Linux distro or repo that ships GTK4 layer-shell support, or point GLIMPSE_BINARY_PATH / GLIMPSE_HOST_PATH at a prebuilt upstream Glimpse host.`;
  }

  return null;
}

function linuxBuildFixes(): string[] {
  const fixes: string[] = [];

  if (!commandAvailable("cargo")) {
    fixes.push("Install Rust from https://rustup.rs so upstream Glimpse can build its Linux host.");
  }

  const missingDeps = missingLinuxBuildDeps();
  if (!commandAvailable("pkg-config")) {
    fixes.push("Install pkg-config so Glimpse can detect the Linux GTK/WebKit development packages.");
  }
  if (missingDeps.length > 0) {
    const ubuntuPackages = ubuntuLinuxBuildPackages(missingDeps);
    if (ubuntuPackages.length > 0) {
      fixes.push(`Ubuntu 24 / WSL2 packages: sudo apt install -y ${ubuntuPackages.join(" ")}.`);
    }
    fixes.push(`Fedora packages: sudo dnf install ${missingDeps.map((dep) => dep.fedora).join(" ")}. Arch packages: sudo pacman -S ${missingDeps.map((dep) => dep.arch).join(" ")}.`);
  }

  const layerShellRepoNote = linuxLayerShellRepoNote(missingDeps);
  if (layerShellRepoNote) {
    fixes.push(layerShellRepoNote);
  }

  const layerShellRepoFix = linuxLayerShellRepoFix(missingDeps);
  if (layerShellRepoFix) {
    fixes.push(layerShellRepoFix);
  }

  const legacyRuntimeNote = legacyLinuxRuntimeNote(missingDeps);
  if (legacyRuntimeNote) {
    fixes.push(legacyRuntimeNote);
  }

  fixes.push("After the prerequisites are present, rerun npm install or npm run build:linux inside node_modules/glimpseui.");
  fixes.push(isWSL() ? "WSLg must be enabled for the supported WSL2 Linux GUI path." : "Run inside a GUI-capable Linux session.");
  return fixes;
}

function glimpseBuildFixes(platform: string): string[] {
  if (platform === "linux") {
    return linuxBuildFixes();
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
  const override = process.env.PI_GENERATIVE_UI_TEST_GLIMPSE_SKIPPED_BUILD_REASON;
  if (override != null) return override.trim() || null;

  const skippedBuildPath = join(resolveGlimpsePackageRoot(modulePath), ".glimpse-build-skipped");
  if (!existsSync(skippedBuildPath)) return null;
  return readFileSync(skippedBuildPath, "utf8").trim() || null;
}

function normalizeSkippedBuildReason(platform: string, skippedBuildReason?: string | null): string | null {
  if (!skippedBuildReason) return null;

  if (platform !== "linux") {
    return skippedBuildReason;
  }

  const trimmed = skippedBuildReason.trim();
  if (!trimmed) return null;

  if (trimmed.includes("GTK4/WebKit2GTK dev packages are missing")) {
    return "Postinstall skipped native build because the Linux GTK4/WebKitGTK 6.0 prerequisites are missing or unavailable in this environment.";
  }

  return trimmed.replace(/See README for install instructions,?\s*/i, "").trim() || null;
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
  const runtimeDependencyFailure = isRuntimeDependencyFailure(message);
  return (
    lower.includes("glimpse host not found")
    || (!runtimeDependencyFailure && (lower.includes("enoent") || lower.includes("no such file or directory")))
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

function linuxMissingHostDetails(skippedBuildReason?: string | null): string | null {
  const details: string[] = [];

  const normalizedSkippedBuildReason = normalizeSkippedBuildReason("linux", skippedBuildReason);
  if (normalizedSkippedBuildReason) {
    details.push(normalizedSkippedBuildReason);
  }

  const missingDeps = missingLinuxBuildDeps();
  if (missingDeps.length > 0) {
    const missingPkgConfigs = missingDeps.map((dep) => dep.pkgConfig).join(", ");
    if (!commandAvailable("pkg-config")) {
      details.push(`pkg-config is unavailable, so Glimpse cannot verify the Linux prerequisites (${missingPkgConfigs}).`);
    } else {
      details.push(`pkg-config still cannot find ${missingPkgConfigs}.`);
    }
  }

  const layerShellRepoNote = linuxLayerShellRepoNote(missingDeps);
  if (layerShellRepoNote) {
    details.push(layerShellRepoNote);
  }

  const legacyRuntimeNote = legacyLinuxRuntimeNote(missingDeps);
  if (legacyRuntimeNote) {
    details.push(legacyRuntimeNote);
  }

  return details.join(" ").trim() || null;
}

function missingHostError(platform: string, hostPath: string, skippedBuildReason?: string | null): BackendSupportError {
  const details = platform === "linux"
    ? linuxMissingHostDetails(skippedBuildReason)
    : normalizeSkippedBuildReason(platform, skippedBuildReason);

  return supportError(
    "BACKEND_BINARY_MISSING",
    details
      ? `Missing upstream Glimpse host at ${hostPath}. ${details}`
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
      if (sawReady) {
        finish({ ok: true as const });
        return;
      }

      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      finish(
        normalizeGlimpseFailure(
          "linux",
          combined || (code === 0
            ? "Upstream Glimpse support probe exited before reporting ready."
            : `Upstream Glimpse support probe failed (code=${code}, signal=${signal}).`),
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
