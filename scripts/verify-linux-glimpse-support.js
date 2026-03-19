import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

if (process.platform !== "linux") {
  throw new Error("scripts/verify-linux-glimpse-support.js must be run on Linux.");
}

const repoRoot = process.cwd();
const requireFromHere = createRequire(path.join(repoRoot, "scripts/postinstall.js"));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  throw new Error(`Linux Glimpse support verification failed.\n\n${message}`);
}

function resolveGlimpseModulePath() {
  return requireFromHere.resolve("glimpseui");
}

function resolveHostPath(modulePath) {
  const override = process.env.GLIMPSE_BINARY_PATH || process.env.GLIMPSE_HOST_PATH;
  return override
    ? (path.isAbsolute(override) ? override : path.resolve(repoRoot, override))
    : path.join(path.dirname(path.dirname(modulePath)), "src", "glimpse");
}

function runTsxSnippet(source) {
  const result = run("npx", ["--yes", "tsx", "-e", source]);
  if (result.status !== 0) {
    fail([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || `Command failed: npx --yes tsx -e ${source}`);
  }
  return result.stdout.trim();
}

const linuxGtk4LayerShellPkgConfig = "gtk4-layer-shell-0";
const ubuntuGtk4LayerShellPackage = "libgtk4-layer-shell-dev";
const ubuntuGtk3LayerShellPackage = "libgtk-layer-shell-dev";
const linuxDeps = [
  { pkgConfig: "gtk4", ubuntu: "libgtk-4-dev" },
  { pkgConfig: "webkitgtk-6.0", ubuntu: "libwebkitgtk-6.0-dev" },
  { pkgConfig: linuxGtk4LayerShellPkgConfig, ubuntu: ubuntuGtk4LayerShellPackage },
];

function missingLinuxDeps() {
  if (run("pkg-config", ["--version"]).status !== 0) {
    return linuxDeps;
  }
  return linuxDeps.filter((dep) => run("pkg-config", ["--exists", dep.pkgConfig]).status !== 0);
}

function hasUbuntuCandidate(pkg) {
  const result = run("apt-cache", ["show", pkg]);
  if (result.error) {
    return null;
  }
  return Boolean((result.stdout ?? "").trim());
}

function ubuntuLayerShellRepoState() {
  const gtk4Candidate = hasUbuntuCandidate(ubuntuGtk4LayerShellPackage);
  const gtk3Candidate = hasUbuntuCandidate(ubuntuGtk3LayerShellPackage);
  if (gtk4Candidate === true) return "gtk4";
  if (gtk4Candidate === false && gtk3Candidate === true) return "gtk3-only";
  if (gtk4Candidate === false && gtk3Candidate === false) return "missing";
  if (gtk4Candidate == null && gtk3Candidate == null) return null;
  return "unknown";
}

function ubuntuLinuxPackages(missingDeps) {
  const layerShellState = ubuntuLayerShellRepoState();
  return Array.from(new Set(missingDeps.flatMap((dep) => {
    if (dep.pkgConfig !== linuxGtk4LayerShellPkgConfig) {
      return dep.ubuntu;
    }
    return layerShellState === "gtk4" ? dep.ubuntu : [];
  })));
}

function ubuntuLinuxPackagesFix(missingDeps) {
  const ubuntuPackages = ubuntuLinuxPackages(missingDeps);
  if (ubuntuPackages.length === 0) {
    return null;
  }

  const missingLayerShell = missingDeps.some((dep) => dep.pkgConfig === linuxGtk4LayerShellPkgConfig);
  const layerShellState = ubuntuLayerShellRepoState();
  if (missingLayerShell && (layerShellState === "gtk3-only" || layerShellState === "missing")) {
    return `Install the available Ubuntu 24 / WSL2 build packages first: sudo apt install -y ${ubuntuPackages.join(" ")}. Default apt repos in this environment still do not provide ${linuxGtk4LayerShellPkgConfig}.`;
  }

  return `Install Ubuntu 24 / WSL2 build packages: sudo apt install -y ${ubuntuPackages.join(" ")}.`;
}

function linuxLayerShellRepoNote(missingDeps) {
  if (!missingDeps.some((dep) => dep.pkgConfig === linuxGtk4LayerShellPkgConfig)) {
    return null;
  }

  const layerShellState = ubuntuLayerShellRepoState();
  if (layerShellState === "gtk3-only") {
    return `Ubuntu 24 apt exposes only ${ubuntuGtk3LayerShellPackage} (GTK3 / gtk-layer-shell-0); it does not satisfy upstream Glimpse's GTK4 layer-shell requirement (${linuxGtk4LayerShellPkgConfig}).`;
  }
  if (layerShellState === "missing") {
    return `Ubuntu 24 apt does not expose a ${ubuntuGtk4LayerShellPackage} package for ${linuxGtk4LayerShellPkgConfig} in this environment.`;
  }
  return null;
}

function linuxLayerShellRepoFix(missingDeps) {
  if (!missingDeps.some((dep) => dep.pkgConfig === linuxGtk4LayerShellPkgConfig)) {
    return null;
  }

  const layerShellState = ubuntuLayerShellRepoState();
  if (layerShellState === "gtk3-only" || layerShellState === "missing") {
    return `Ubuntu 24 / WSL2 cannot satisfy ${linuxGtk4LayerShellPkgConfig} from the default apt repos in this environment. The current upstream glimpseui build:linux hint still mentions ${ubuntuGtk4LayerShellPackage}, but that package is not available here. Use a Linux distro or repo that ships GTK4 layer-shell support, or point GLIMPSE_BINARY_PATH / GLIMPSE_HOST_PATH at a prebuilt upstream Glimpse host.`;
  }

  return null;
}

function detectedLegacyLinuxRuntimePackages() {
  const result = run("ldconfig", ["-p"]);
  if (result.status !== 0) {
    return [];
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const detected = [];
  if (output.includes("libwebkit2gtk-4.1.so")) detected.push("WebKitGTK 4.1");
  if (output.includes("libjavascriptcoregtk-4.1.so")) detected.push("JavaScriptCoreGTK 4.1");
  return detected;
}

const modulePath = resolveGlimpseModulePath();
const packageRoot = path.dirname(path.dirname(modulePath));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const skippedBuildPath = path.join(packageRoot, ".glimpse-build-skipped");
const skippedBuildReason = existsSync(skippedBuildPath)
  ? readFileSync(skippedBuildPath, "utf8").trim()
  : null;
const hostPath = resolveHostPath(modulePath);

const cargoCheck = run("cargo", ["--version"]);
const pkgConfigVersionCheck = run("pkg-config", ["--version"]);
const missingDeps = missingLinuxDeps();
const ubuntuLayerShellState = ubuntuLayerShellRepoState();
const layerShellRepoNote = linuxLayerShellRepoNote(missingDeps);
const layerShellRepoFix = linuxLayerShellRepoFix(missingDeps);
const legacyLinuxRuntime = detectedLegacyLinuxRuntimePackages();
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const sudoCheck = run("sudo", ["-n", "true"]);
const hostExists = existsSync(hostPath);
let hostExecutable = false;
if (hostExists) {
  try {
    accessSync(hostPath, constants.X_OK);
    hostExecutable = true;
  } catch {
    hostExecutable = false;
  }
}

log(`glimpseui=${packageJson.name}@${packageJson.version}`);
log(`modulePath=${modulePath}`);
log(`hostPath=${hostPath}`);
log(`display=${hasDisplay ? (process.env.WAYLAND_DISPLAY || process.env.DISPLAY) : "<missing>"}`);
log(`cargo=${cargoCheck.status === 0 ? (cargoCheck.stdout.trim() || cargoCheck.stderr.trim() || "present") : "missing"}`);
log(`pkgConfig=${pkgConfigVersionCheck.status === 0 ? (pkgConfigVersionCheck.stdout.trim() || "present") : "missing"}`);
log(`pkgConfigLinuxDeps=${missingDeps.length === 0 ? "ok" : `missing:${missingDeps.map((dep) => dep.pkgConfig).join(",")}`}`);
log(`ubuntuLayerShellRepo=${ubuntuLayerShellState ?? "n/a"}`);
if (layerShellRepoNote) {
  log(`layerShellRepoNote=${layerShellRepoNote}`);
}
log(`legacyLinuxRuntime=${legacyLinuxRuntime.length === 0 ? "none" : legacyLinuxRuntime.join(",")}`);
log(`sudo=${sudoCheck.status === 0 ? "passwordless" : "password-required-or-missing"}`);
log(`hostExists=${hostExists}`);
log(`hostExecutable=${hostExecutable}`);
if (skippedBuildReason) {
  log(`skippedBuild=${skippedBuildReason}`);
}

const kindOutput = runTsxSnippet("import { getWidgetBackend } from './src/backend/index.ts'; const backend = getWidgetBackend(); console.log(JSON.stringify({ kind: backend.kind }));");
const supportOutput = runTsxSnippet("import { getWidgetBackend } from './src/backend/index.ts'; const backend = getWidgetBackend(); Promise.resolve(backend.checkSupport()).then((support) => console.log(JSON.stringify(support))); ");

log(`backendKind=${kindOutput}`);
log(`backendSupport=${supportOutput}`);

const kind = JSON.parse(kindOutput);
const support = JSON.parse(supportOutput);

if (kind.kind !== "glimpse") {
  fail(`Expected backend kind=glimpse, got ${kindOutput}`);
}

if (String(support.reason ?? "").includes("See README for install instructions")) {
  fail(`checkSupport() leaked misleading upstream README guidance: ${supportOutput}`);
}

if (!support.ok) {
  const nextSteps = [];
  if (!hasDisplay) {
    nextSteps.push("Launch pi from a Linux GUI session with DISPLAY or WAYLAND_DISPLAY set.");
  }
  if (cargoCheck.status !== 0) {
    nextSteps.push("Install Rust from https://rustup.rs.");
  }
  if (pkgConfigVersionCheck.status !== 0) {
    nextSteps.push("Install pkg-config so the upstream Glimpse build can detect Linux GTK/WebKit development packages.");
  }
  if (missingDeps.length > 0) {
    const ubuntuPackagesFix = ubuntuLinuxPackagesFix(missingDeps);
    if (ubuntuPackagesFix) {
      nextSteps.push(ubuntuPackagesFix);
    }
  }
  if (layerShellRepoNote) {
    nextSteps.push(layerShellRepoNote);
  }
  if (layerShellRepoFix) {
    nextSteps.push(layerShellRepoFix);
  }
  if (legacyLinuxRuntime.length > 0 && missingDeps.some((dep) => dep.pkgConfig === "webkitgtk-6.0")) {
    nextSteps.push(`This machine still exposes legacy ${legacyLinuxRuntime.join(" + ")} runtime libraries from the old helper-era stack; they do not satisfy upstream Glimpse's WebKitGTK 6.0 requirement.`);
  }
  if (sudoCheck.status !== 0 && missingDeps.length > 0) {
    nextSteps.push("This environment does not currently have passwordless sudo, so the missing system packages cannot be installed autonomously here.");
  }
  if (!hostExists || !hostExecutable || skippedBuildReason) {
    nextSteps.push("After prerequisites are present, run: npm --prefix node_modules/glimpseui run build:linux");
  }
  fail([
    `checkSupport() did not return { ok: true }: ${supportOutput}`,
    nextSteps.length ? `Next steps:\n- ${nextSteps.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n"));
}

log("Linux Glimpse support verification passed.");
