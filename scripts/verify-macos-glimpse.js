const { spawn } = require("node:child_process");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const repoRoot = path.resolve(__dirname, "..");
const piBin = process.env.PI_VERIFY_PI_BIN || "pi";
const scenarioTimeoutMs = Number(process.env.PI_VERIFY_TIMEOUT_MS || 180000);
const forwardedArgs = process.argv.slice(2);

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

const scenarios = [
  {
    name: "message roundtrip",
    prompt: createPrompt(
      "macos_glimpse_roundtrip",
      `<style>body{font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}button{padding:10px 14px;border-radius:10px;border:0;background:#4f46e5;color:#fff;font-weight:600}</style><main><button id="send">macOS Glimpse roundtrip</button></main><script>setTimeout(()=>window.glimpse.send({ok:true,backend:'mac-glimpse',title:document.title||'macos_glimpse_roundtrip'}),300);</script>`
    ),
    validate(toolResult) {
      const details = toolResult?.result?.details ?? {};
      if (details?.messageData?.ok !== true) {
        throw new Error(`Expected messageData.ok === true, got ${JSON.stringify(details?.messageData)}`);
      }
      if (details?.messageData?.backend !== "mac-glimpse") {
        throw new Error(`Expected backend marker 'mac-glimpse', got ${JSON.stringify(details?.messageData)}`);
      }
    },
  },
  {
    name: "close semantics",
    prompt: createPrompt(
      "macos_glimpse_close",
      `<style>body{font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}</style><main>macOS Glimpse close check</main><script>setTimeout(()=>window.glimpse.close(),300);</script>`
    ),
    validate(toolResult) {
      const details = toolResult?.result?.details ?? {};
      if (details?.closedReason !== "Window closed by user.") {
        throw new Error(`Expected closedReason to be 'Window closed by user.', got ${JSON.stringify(details?.closedReason)}`);
      }
    },
  },
];

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("scripts/verify-macos-glimpse.js must be run in a real macOS environment.");
  }

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
    } catch (error) {
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
    return await responsePromise;
  };

  try {
    for (const scenario of scenarios) {
      const scenarioPromise = onceScenario(state, scenario);
      await sendCommand({ type: "prompt", message: scenario.prompt });
      await scenarioPromise;
      process.stdout.write(`✓ ${scenario.name}\n`);
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
