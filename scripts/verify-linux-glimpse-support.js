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

const modulePath = resolveGlimpseModulePath();
const packageRoot = path.dirname(path.dirname(modulePath));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const skippedBuildPath = path.join(packageRoot, ".glimpse-build-skipped");
const skippedBuildReason = existsSync(skippedBuildPath)
  ? readFileSync(skippedBuildPath, "utf8").trim()
  : null;
const hostPath = resolveHostPath(modulePath);

const cargoCheck = run("cargo", ["--version"]);
const pkgConfigCheck = run("pkg-config", ["--exists", "webkitgtk-6.0", "gtk4", "gtk4-layer-shell-0"]);
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
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
log(`pkgConfigLinuxDeps=${pkgConfigCheck.status === 0 ? "ok" : "missing"}`);
log(`hostExists=${hostExists}`);
log(`hostExecutable=${hostExecutable}`);
if (skippedBuildReason) {
  log(`skippedBuild=${skippedBuildReason}`);
}

const kindOutput = runTsxSnippet("import { getWidgetBackend } from './.pi/extensions/generative-ui/backend/index.ts'; const backend = getWidgetBackend(); console.log(JSON.stringify({ kind: backend.kind }));");
const supportOutput = runTsxSnippet("import { getWidgetBackend } from './.pi/extensions/generative-ui/backend/index.ts'; const backend = getWidgetBackend(); Promise.resolve(backend.checkSupport()).then((support) => console.log(JSON.stringify(support))); ");

log(`backendKind=${kindOutput}`);
log(`backendSupport=${supportOutput}`);

const kind = JSON.parse(kindOutput);
const support = JSON.parse(supportOutput);

if (kind.kind !== "glimpse") {
  fail(`Expected backend kind=glimpse, got ${kindOutput}`);
}

if (!support.ok) {
  const nextSteps = [];
  if (!hasDisplay) {
    nextSteps.push("Launch pi from a Linux GUI session with DISPLAY or WAYLAND_DISPLAY set.");
  }
  if (cargoCheck.status !== 0) {
    nextSteps.push("Install Rust from https://rustup.rs.");
  }
  if (pkgConfigCheck.status !== 0) {
    nextSteps.push("Install Ubuntu 24 / WSL2 build packages: sudo apt install -y libgtk-4-dev libwebkitgtk-6.0-dev libgtk4-layer-shell-dev.");
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
