import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(process.cwd());

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function requireSuccess(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`.trim());
  }
  return result;
}

function createMockModule(modulePath, logPath) {
  writeFileSync(modulePath, `
import { appendFileSync } from "node:fs";

const logPath = process.env.PI_GENERATIVE_UI_GLIMPSE_LOG;

function log(event, data) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify({ event, ...data }) + "\\n");
}

export function open(html, options) {
  log("open", { title: options.title, width: options.width, height: options.height, htmlLength: html.length });
  const handlers = new Map();
  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    send(js) {
      log("send", { title: options.title, js });
      if (String(js).includes("__triggerMessage__")) {
        queueMicrotask(() => emit("message", { ok: true, backend: "glimpse-mock", title: options.title }));
      }
    },
    close() {
      log("close", { title: options.title });
      emit("closed");
    }
  };
}
`, "utf8");
  writeFileSync(logPath, "", "utf8");
}

function createHostScript(hostPath, body, mode = 0o755) {
  writeFileSync(hostPath, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(hostPath, mode);
}

function compileBackend(outDir) {
  requireSuccess("tsc", [
    "--module", "es2022",
    "--moduleResolution", "bundler",
    "--target", "es2022",
    "--skipLibCheck",
    "--outDir", outDir,
    ".pi/extensions/generative-ui/backend/index.ts",
    ".pi/extensions/generative-ui/backend/glimpse.ts",
    ".pi/extensions/generative-ui/backend/errors.ts",
    ".pi/extensions/generative-ui/backend/types.ts",
  ]);
}

function runNodeSnippet(source, env) {
  const result = run("node", ["--input-type=module", "-e", source], {
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
  }
  return result.stdout.trim();
}

function expectSupportScenario(glimpsePath, env, validate, label) {
  const output = runNodeSnippet(
    `
      import { GlimpseBackend } from ${JSON.stringify(pathToFileUrl(glimpsePath))};

      const backend = new GlimpseBackend();
      const support = await backend.checkSupport();
      console.log(JSON.stringify(support));
    `,
    env,
  );

  const support = JSON.parse(output);
  validate(support, output);
  process.stdout.write(`✓ ${label}\n`);
}

function expectCode(support, output, code) {
  if (support.ok !== false || support.code !== code) {
    throw new Error(`Unexpected diagnostic for ${code}: ${output}`);
  }
}

function expectFixIncludes(support, output, fragment) {
  if (!Array.isArray(support.fixes) || !support.fixes.some((fix) => String(fix).includes(fragment))) {
    throw new Error(`Expected fix containing ${JSON.stringify(fragment)}: ${output}`);
  }
}

function expectFixExcludes(support, output, fragment) {
  if (Array.isArray(support.fixes) && support.fixes.some((fix) => String(fix).includes(fragment))) {
    throw new Error(`Did not expect fix containing ${JSON.stringify(fragment)}: ${output}`);
  }
}

function expectReasonIncludes(support, output, fragment) {
  if (!String(support.reason ?? "").includes(fragment)) {
    throw new Error(`Expected reason containing ${JSON.stringify(fragment)}: ${output}`);
  }
}

function expectReasonExcludes(support, output, fragment) {
  if (String(support.reason ?? "").includes(fragment)) {
    throw new Error(`Did not expect reason containing ${JSON.stringify(fragment)}: ${output}`);
  }
}

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pi-glimpse-fallback-"));
  const compiledDir = path.join(tempDir, "compiled");
  const mockModulePath = path.join(tempDir, "glimpse-mock.mjs");
  const logPath = path.join(tempDir, "glimpse-log.jsonl");
  const readyHostPath = path.join(tempDir, "glimpse-ready-host.mjs");
  const runtimeFailHostPath = path.join(tempDir, "glimpse-runtime-fail-host.mjs");
  const genericFailHostPath = path.join(tempDir, "glimpse-generic-fail-host.mjs");
  const prematureExitHostPath = path.join(tempDir, "glimpse-premature-exit-host.mjs");
  const nonExecHostPath = path.join(tempDir, "glimpse-nonexec-host.mjs");

  try {
    compileBackend(compiledDir);
    createMockModule(mockModulePath, logPath);
    createHostScript(
      readyHostPath,
      `
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes('"type":"close"') || buffer.includes('"type": "close"')) {
    process.exit(0);
  }
});
setTimeout(() => process.exit(0), 1500);
`,
    );
    createHostScript(
      runtimeFailHostPath,
      `
process.stderr.write("error while loading shared libraries: libwebkitgtk-6.0.so: cannot open shared object file\\n");
process.exit(127);
`,
    );
    createHostScript(
      genericFailHostPath,
      `
process.stderr.write("glimpse exploded in a generic way\\n");
process.exit(1);
`,
    );
    createHostScript(
      prematureExitHostPath,
      `
process.exit(0);
`,
    );
    createHostScript(nonExecHostPath, "process.exit(0);", 0o644);

    const indexPath = path.join(compiledDir, "index.js");
    const glimpsePath = path.join(compiledDir, "glimpse.js");

    const successOutput = runNodeSnippet(
      `
        import { getWidgetBackend } from ${JSON.stringify(pathToFileUrl(indexPath))};

        const backend = getWidgetBackend();
        const support = await backend.checkSupport();
        if (backend.kind !== "glimpse") throw new Error("Expected Glimpse backend selection.");
        if (!support.ok) throw new Error(JSON.stringify(support));

        const win = await backend.open("<div>mock</div>", { title: "mock glimpse", width: 420, height: 220 });
        const message = await new Promise((resolve, reject) => {
          win.on("message", resolve);
          win.on("error", reject);
          win.send("__triggerMessage__");
        });
        const closed = await new Promise((resolve, reject) => {
          win.on("closed", () => resolve(true));
          win.on("error", reject);
          win.close();
        });

        console.log(JSON.stringify({ kind: backend.kind, support, message, closed }));
      `,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: readyHostPath,
        PI_GENERATIVE_UI_GLIMPSE_LOG: logPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
    );

    const success = JSON.parse(successOutput);
    if (success.kind !== "glimpse" || !success.support?.ok || success.message?.backend !== "glimpse-mock" || success.closed !== true) {
      throw new Error(`Unexpected success scenario output: ${successOutput}`);
    }

    const logEntries = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const events = logEntries.map((entry) => entry.event);
    if (!events.includes("open") || !events.includes("send") || !events.includes("close")) {
      throw new Error(`Expected mock Glimpse open/send/close events, got ${JSON.stringify(logEntries)}`);
    }
    process.stdout.write("✓ mocked Glimpse Linux adapter contract\n");

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: path.join(tempDir, "missing-glimpse.mjs"),
        GLIMPSE_BINARY_PATH: readyHostPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "BACKEND_BINARY_MISSING");
        if (!Array.isArray(support.fixes) || !support.fixes.some((fix) => String(fix).includes("npm install"))) {
          throw new Error(`Missing npm install guidance: ${output}`);
        }
      },
      "missing Glimpse module diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_TEST_WSL: "0",
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "NO_GUI_DISPLAY");
      },
      "missing Linux display diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_TEST_WSL: "1",
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "WSLG_REQUIRED");
      },
      "missing WSLg diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_TEST_COMMAND_CARGO: "1",
        PI_GENERATIVE_UI_TEST_MISSING_LINUX_PKG_CONFIG: "webkitgtk-6.0,gtk4-layer-shell-0",
        PI_GENERATIVE_UI_TEST_UBUNTU_LAYER_SHELL_STATE: "gtk3-only",
        PI_GENERATIVE_UI_TEST_LEGACY_LINUX_RUNTIME: "WebKitGTK 4.1,JavaScriptCoreGTK 4.1",
        PI_GENERATIVE_UI_TEST_GLIMPSE_SKIPPED_BUILD_REASON: "Postinstall skipped native build because GTK4/WebKit2GTK dev packages are missing. See README for install instructions, then run npm run build:linux.",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: path.join(tempDir, "missing-glimpse-host"),
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "BACKEND_BINARY_MISSING");
        expectReasonIncludes(support, output, "Postinstall skipped native build because the Linux GTK4/WebKitGTK 6.0 prerequisites are missing or unavailable in this environment.");
        expectReasonIncludes(support, output, "pkg-config still cannot find webkitgtk-6.0, gtk4-layer-shell-0");
        expectReasonIncludes(support, output, "Ubuntu 24 apt exposes only libgtk-layer-shell-dev");
        expectReasonExcludes(support, output, "See README for install instructions");
        expectFixIncludes(support, output, "libwebkitgtk-6.0-dev");
        expectFixIncludes(support, output, "Ubuntu 24 apt exposes only libgtk-layer-shell-dev");
        expectFixIncludes(support, output, "legacy WebKitGTK 4.1 + JavaScriptCoreGTK 4.1 runtime libraries");
        expectFixExcludes(support, output, "libgtk4-layer-shell-dev");
        expectFixExcludes(support, output, "libgtk-4-dev");
        expectFixExcludes(support, output, "Install Rust from https://rustup.rs");
      },
      "missing Glimpse host diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: nonExecHostPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "BACKEND_BINARY_NOT_EXECUTABLE");
      },
      "non-executable Glimpse host diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: runtimeFailHostPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "WEBKIT_RUNTIME_MISSING");
      },
      "Linux GTK/WebKit runtime diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: prematureExitHostPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "BACKEND_START_FAILED");
        expectReasonIncludes(support, output, "exited before reporting ready");
      },
      "premature Glimpse probe exit diagnostics",
    );

    expectSupportScenario(
      glimpsePath,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "linux",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        GLIMPSE_BINARY_PATH: genericFailHostPath,
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      },
      (support, output) => {
        expectCode(support, output, "BACKEND_START_FAILED");
      },
      "generic Glimpse startup diagnostics",
    );

    process.stdout.write("Mocked Glimpse backend verification passed.\n");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function pathToFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
