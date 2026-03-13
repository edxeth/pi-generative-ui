import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function compileBackend(outDir) {
  requireSuccess("tsc", [
    "--module", "es2022",
    "--moduleResolution", "bundler",
    "--target", "es2022",
    "--skipLibCheck",
    "--outDir", outDir,
    ".pi/extensions/generative-ui/backend/index.ts",
    ".pi/extensions/generative-ui/backend/glimpse.ts",
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

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "pi-glimpse-fallback-"));
  const compiledDir = path.join(tempDir, "compiled");
  const mockModulePath = path.join(tempDir, "glimpse-mock.mjs");
  const logPath = path.join(tempDir, "glimpse-log.jsonl");

  try {
    compileBackend(compiledDir);
    createMockModule(mockModulePath, logPath);

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
        PI_GENERATIVE_UI_TEST_PLATFORM: "darwin",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: mockModulePath,
        PI_GENERATIVE_UI_GLIMPSE_LOG: logPath,
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
    process.stdout.write("✓ mocked Glimpse adapter contract\n");

    const missingOutput = runNodeSnippet(
      `
        import { GlimpseBackend } from ${JSON.stringify(pathToFileUrl(glimpsePath))};

        const backend = new GlimpseBackend();
        const support = await backend.checkSupport();
        console.log(JSON.stringify(support));
      `,
      {
        PI_GENERATIVE_UI_TEST_PLATFORM: "darwin",
        PI_GENERATIVE_UI_GLIMPSE_MODULE: path.join(tempDir, "missing-glimpse.mjs"),
      },
    );

    const missing = JSON.parse(missingOutput);
    if (
      missing.ok !== false
      || missing.code !== "BACKEND_START_FAILED"
      || !Array.isArray(missing.fixes)
      || !missing.fixes.some((fix) => String(fix).includes("npm install"))
    ) {
      throw new Error(`Unexpected missing-module diagnostic: ${missingOutput}`);
    }
    process.stdout.write("✓ missing Glimpse dependency diagnostics\n");

    process.stdout.write("Mocked Glimpse fallback verification passed.\n");
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
