import { spawn } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const repoRoot = path.resolve(process.cwd());
const piBin = process.env.PI_VERIFY_PI_BIN || "pi";
const scenarioTimeoutMs = Number(process.env.PI_VERIFY_TIMEOUT_MS || 180000);
const windowTimeoutMs = Number(process.env.PI_VERIFY_WINDOW_TIMEOUT_MS || 20000);
const windowPollMs = Number(process.env.PI_VERIFY_WINDOW_POLL_MS || 250);
const commandTimeoutMs = Number(process.env.PI_VERIFY_COMMAND_TIMEOUT_MS || 15000);
const forwardedArgs = process.argv.slice(2);

const LIST_WINDOWS_JXA = String.raw`(() => {
  const systemEvents = Application('System Events');
  const titles = [];
  for (const process of systemEvents.processes.whose({ visible: true })()) {
    for (const window of process.windows()) {
      try {
        const title = String(window.name() || '');
        if (title) titles.push(title);
      } catch (error) {}
    }
  }
  return JSON.stringify(titles);
})()`;

const CLOSE_WINDOW_JXA = String.raw`(() => {
  ObjC.import('stdlib');
  const target = $.getenv('PI_TARGET_TITLE').js;
  const systemEvents = Application('System Events');

  for (const process of systemEvents.processes.whose({ visible: true })()) {
    for (const window of process.windows()) {
      try {
        if (String(window.name() || '') !== target) continue;
        const closeAction = window.actions.byName('AXClose');
        closeAction.perform();
        return 'closed';
      } catch (error) {}
    }
  }

  throw new Error('Window not found or not closable: ' + target);
})()`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.trim()) onLine(line);
  });
}

function onceResponse(state, id) {
  return new Promise((resolve, reject) => {
    state.pendingResponses.set(id, { resolve, reject });
  });
}

function onceScenario(state, scenario) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingScenario = null;
      reject(new Error(`${scenario.name} timed out after ${scenarioTimeoutMs}ms.`));
    }, scenarioTimeoutMs);

    state.pendingScenario = {
      scenario,
      toolResult: null,
      finish(event) {
        clearTimeout(timer);
        state.pendingScenario = null;
        resolve({ event, toolResult: this.toolResult });
      },
      fail(error) {
        clearTimeout(timer);
        state.pendingScenario = null;
        reject(error);
      },
    };
  });
}

function createPrompt(widgetTitle, widgetCode) {
  return [
    "Silently call visualize_read_me with the interactive module.",
    "Then call show_widget exactly once with i_have_seen_read_me=true.",
    `Use title=${JSON.stringify(widgetTitle)}, width=420, height=220.`,
    `Use widget_code=${JSON.stringify(widgetCode)}.`,
    "After the tool finishes, reply with one short sentence.",
  ].join(" ");
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? repoRoot;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      reject(new Error(`Timed out after ${timeoutMs}ms: ${formatCommand(command, args)}`));
    }, timeoutMs);

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function requireSuccessfulCommand(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(`${formatCommand(command, args)} failed.${details ? `\n${details}` : ""}`);
  }
  return result;
}

async function listMacWindowTitles() {
  const result = await requireSuccessfulCommand("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS_JXA]);
  const output = result.stdout.trim();
  if (!output) return [];

  try {
    const titles = JSON.parse(output);
    return Array.isArray(titles) ? titles.filter((title) => typeof title === "string") : [];
  } catch {
    throw new Error(`Failed to parse macOS window titles: ${output}`);
  }
}

async function waitForWindowTitle(title, present = true, timeoutMs = windowTimeoutMs) {
  const startedAt = Date.now();
  let lastTitles = [];

  while (Date.now() - startedAt < timeoutMs) {
    lastTitles = await listMacWindowTitles();
    const hasTitle = lastTitles.includes(title);
    if (hasTitle === present) return lastTitles;
    await sleep(windowPollMs);
  }

  throw new Error(
    present
      ? `Timed out waiting for native macOS window ${JSON.stringify(title)}. Visible titles: ${JSON.stringify(lastTitles)}`
      : `Timed out waiting for native macOS window ${JSON.stringify(title)} to disappear. Visible titles: ${JSON.stringify(lastTitles)}`
  );
}

async function closeWindowByTitle(title) {
  await requireSuccessfulCommand(
    "osascript",
    ["-l", "JavaScript", "-e", CLOSE_WINDOW_JXA],
    {
      env: { ...process.env, PI_TARGET_TITLE: title },
    },
  );
}

async function closeWindowIfPresent(title) {
  const titles = await listMacWindowTitles();
  if (!titles.includes(title)) return false;
  await closeWindowByTitle(title);
  await waitForWindowTitle(title, false);
  return true;
}

function logScenarioStep(scenarioName, step) {
  process.stdout.write(`[${scenarioName}] ${step}\n`);
}

function createMessageRoundtripScenario() {
  const token = `roundtrip-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const widgetTitle = "macos_glimpse_roundtrip";
  const windowTitle = widgetTitle.replace(/_/g, " ");
  const payload = {
    ok: true,
    backend: "mac-glimpse",
    scenario: "message-roundtrip",
    token,
  };

  return {
    name: "message roundtrip",
    widgetTitle,
    windowTitle,
    prompt: createPrompt(
      widgetTitle,
      `<style>body{font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}button{padding:10px 14px;border-radius:10px;border:0;background:#4f46e5;color:#fff;font-weight:600}</style><main><button id="send">macOS Glimpse roundtrip</button></main><script>setTimeout(()=>window.glimpse.send(${JSON.stringify(payload)}),1200);</script>`,
    ),
    async onPrompt() {
      logScenarioStep(this.name, `waiting for native window ${JSON.stringify(windowTitle)}`);
      await waitForWindowTitle(windowTitle, true);
      logScenarioStep(this.name, `observed native window ${JSON.stringify(windowTitle)}`);
    },
    validate(toolResult) {
      const details = toolResult?.result?.details ?? {};
      const messageData = details?.messageData;
      if (!messageData || typeof messageData !== "object") {
        throw new Error(`Expected messageData object, got ${JSON.stringify(messageData)}`);
      }
      if (
        messageData.ok !== true
        || messageData.backend !== payload.backend
        || messageData.scenario !== payload.scenario
        || messageData.token !== payload.token
      ) {
        throw new Error(`Unexpected messageData payload: ${JSON.stringify(messageData)}`);
      }
    },
    async cleanup() {
      logScenarioStep(this.name, `closing native window ${JSON.stringify(windowTitle)} after roundtrip`);
      await closeWindowIfPresent(windowTitle);
    },
  };
}

function createManualCloseScenario() {
  const widgetTitle = "macos_glimpse_manual_close";
  const windowTitle = widgetTitle.replace(/_/g, " ");

  return {
    name: "manual close semantics",
    widgetTitle,
    windowTitle,
    prompt: createPrompt(
      widgetTitle,
      `<style>body{font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}</style><main>macOS Glimpse manual close check</main>`,
    ),
    async onPrompt() {
      logScenarioStep(this.name, `waiting for native window ${JSON.stringify(windowTitle)}`);
      await waitForWindowTitle(windowTitle, true);
      logScenarioStep(this.name, `closing native window ${JSON.stringify(windowTitle)} via System Events`);
      await closeWindowByTitle(windowTitle);
      await waitForWindowTitle(windowTitle, false);
    },
    validate(toolResult) {
      const details = toolResult?.result?.details ?? {};
      if (details?.closedReason !== "Window closed by user.") {
        throw new Error(`Expected closedReason to be 'Window closed by user.', got ${JSON.stringify(details?.closedReason)}`);
      }
    },
  };
}

async function assertPrerequisites() {
  if (process.platform !== "darwin") {
    throw new Error("scripts/verify-macos-glimpse.js must be run in a real macOS environment.");
  }

  await requireSuccessfulCommand(piBin, ["--version"]);
  await requireSuccessfulCommand("osascript", ["-l", "JavaScript", "-e", "'ok'"]);
}

async function main() {
  await assertPrerequisites();

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "-e",
    repoRoot,
    ...forwardedArgs,
  ];

  const child = spawn(piBin, args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const state = {
    pendingResponses: new Map(),
    pendingScenario: null,
  };

  attachJsonlReader(child.stdout, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (state.pendingScenario) state.pendingScenario.fail(new Error(`Invalid JSON from pi: ${line}`));
      return;
    }

    if (message.type === "response" && message.id) {
      const pending = state.pendingResponses.get(message.id);
      if (pending) {
        state.pendingResponses.delete(message.id);
        if (message.success) pending.resolve(message);
        else pending.reject(new Error(message.error || `${message.command} failed`));
      }
      return;
    }

    if (message.type === "extension_error" && state.pendingScenario) {
      state.pendingScenario.fail(new Error(`Extension error in ${message.event}: ${message.error}`));
      return;
    }

    if (message.type === "tool_execution_end" && message.toolName === "show_widget" && state.pendingScenario) {
      state.pendingScenario.toolResult = message;
      if (message.isError) {
        state.pendingScenario.fail(new Error(`show_widget failed: ${JSON.stringify(message.result)}`));
      }
      return;
    }

    if (message.type === "agent_end" && state.pendingScenario) {
      try {
        if (!state.pendingScenario.toolResult) {
          throw new Error(`Scenario '${state.pendingScenario.scenario.name}' ended without a show_widget result.`);
        }
        state.pendingScenario.scenario.validate(state.pendingScenario.toolResult);
        state.pendingScenario.finish(message);
      } catch (error) {
        state.pendingScenario.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const sendCommand = async (command) => {
    const id = `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const responsePromise = onceResponse(state, id);
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return responsePromise;
  };

  try {
    for (const scenario of [createMessageRoundtripScenario(), createManualCloseScenario()]) {
      logScenarioStep(scenario.name, "starting");
      const scenarioPromise = onceScenario(state, scenario);
      await sendCommand({ type: "prompt", message: scenario.prompt });
      if (scenario.onPrompt) await scenario.onPrompt();
      await scenarioPromise;
      if (scenario.cleanup) await scenario.cleanup();
      logScenarioStep(scenario.name, "passed");
    }
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {}
  }

  const exitCode = child.exitCode ?? child.signalCode ?? await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(code ?? signal ?? 0));
  });
  if (exitCode !== 0 && stderr.trim()) {
    throw new Error(stderr.trim());
  }

  process.stdout.write("macOS Glimpse regression harness passed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
