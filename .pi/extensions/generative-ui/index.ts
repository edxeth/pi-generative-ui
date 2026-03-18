import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { getGuidelines, AVAILABLE_MODULES } from "./guidelines.js";
import { getWidgetBackend, formatSupportError, type WidgetWindow } from "./backend/index.js";

interface FollowUpPromptMessage {
  type: "follow_up_prompt";
  prompt: string;
  replyMode?: "followUp" | "steer";
}

function widgetBridgeScript(): string {
  return `<script>
  window.sendPrompt = function(prompt, replyMode) {
    if (!window.glimpse || typeof window.glimpse.send !== 'function') return;
    if (typeof prompt !== 'string' || !prompt.trim()) return;
    window.glimpse.send({
      type: 'follow_up_prompt',
      prompt: prompt,
      replyMode: replyMode === 'steer' ? 'steer' : 'followUp'
    });
  };
</script>`;
}

function extractFollowUpPromptMessage(data: unknown): FollowUpPromptMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "follow_up_prompt") return null;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) return null;
  return {
    type: "follow_up_prompt",
    prompt: record.prompt.trim(),
    replyMode: record.replyMode === "steer" ? "steer" : "followUp",
  };
}

// Shell HTML with a root container — used for streaming.
// Content is injected via win.send() JS eval, not a full reload, to avoid flashes.
function shellHTML(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{box-sizing:border-box}
body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;}
@keyframes _fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
</style>
</head><body><div id="root"></div>
<script>
  window._morphReady = false;
  window._pending = null;
  window.piGenerativeUiStreamingMetrics = { contentUpdates: 0, scriptRuns: 0 };
  window.__PI_GENERATIVE_UI_STREAMING_METRICS__ = window.piGenerativeUiStreamingMetrics;
  window._setContent = function(html) {
    if (!window._morphReady) { window._pending = html; return; }
    window.__PI_GENERATIVE_UI_STREAMING_METRICS__.contentUpdates += 1;
    var root = document.getElementById('root');
    var target = document.createElement('div');
    target.id = 'root';
    target.innerHTML = html;
    morphdom(root, target, {
      onBeforeElUpdated: function(from, to) {
        if (from.isEqualNode(to)) return false;
        return true;
      },
      onNodeAdded: function(node) {
        if (node.nodeType === 1 && node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT') {
          node.style.animation = '_fadeIn 0.3s ease both';
        }
        return node;
      }
    });
  };
  window._runScripts = function() {
    window.__PI_GENERATIVE_UI_STREAMING_METRICS__.scriptRuns += 1;
    document.querySelectorAll('#root script').forEach(function(old) {
      var s = document.createElement('script');
      if (old.src) { s.src = old.src; } else { s.textContent = old.textContent; }
      old.parentNode.replaceChild(s, old);
    });
  };
</script>
${widgetBridgeScript()}
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;if(window._pending){window._setContent(window._pending);window._pending=null;}"></script>
</body></html>`;
}

// Wrap HTML fragment into a full document for non-streaming fallback.
function wrapHTML(code: string, isSVG = false): string {
  if (isSVG) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}
${widgetBridgeScript()}</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0}</style>
</head><body>${code}
${widgetBridgeScript()}</body></html>`;
}

// Escape a string for safe injection into a JS string literal.
function escapeJS(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\/script>/gi, "<\\/script>");
}

export default function (pi: ExtensionAPI) {
  const backend = getWidgetBackend();
  let hasSeenReadMe = false;
  let activeWindows: WidgetWindow[] = [];

  interface StreamingWidget {
    contentIndex: number;
    window: WidgetWindow | null;
    lastHTML: string;
    finalHTML: string | null;
    finalApplied: boolean;
    updateTimer: NodeJS.Timeout | null;
    ready: boolean;
    opening: Promise<WidgetWindow> | null;
    placeholderApplied: boolean;
    delayedFinalPending: boolean;
    title: string;
    width: number;
    height: number;
    floating: boolean;
  }

  type WidgetTerminalPhase = "preparing" | "generating" | "opening" | "ready";

  let streaming: StreamingWidget | null = null;
  let widgetTerminalStatus: {
    title: string;
    width: number;
    height: number;
    phase: WidgetTerminalPhase;
  } | null = null;

  function normalizeWidgetTitle(title: string) {
    return title.replace(/_/g, " ");
  }

  function setWidgetTerminalStatus(title: string, width: number, height: number, phase: WidgetTerminalPhase) {
    widgetTerminalStatus = {
      title: normalizeWidgetTitle(title),
      width,
      height,
      phase,
    };
  }

  function clearWidgetTerminalStatus() {
    widgetTerminalStatus = null;
  }

  function getWidgetTerminalPhase(args: any): WidgetTerminalPhase | null {
    if (!widgetTerminalStatus) return null;
    const title = normalizeWidgetTitle(args.title ?? "widget");
    const width = args.width ?? 800;
    const height = args.height ?? 600;
    if (widgetTerminalStatus.title !== title) return null;
    if (widgetTerminalStatus.width !== width || widgetTerminalStatus.height !== height) return null;
    return widgetTerminalStatus.phase;
  }

  function sendStreamingContent(streamState: StreamingWidget, html: string, runScripts = false) {
    if (!streamState.window || !streamState.ready) return false;
    const escaped = escapeJS(html);
    streamState.window.send(runScripts
      ? `window._setContent('${escaped}'); window._runScripts();`
      : `window._setContent('${escaped}')`
    );
    if (runScripts) {
      streamState.finalHTML = html;
      streamState.finalApplied = true;
    }
    return true;
  }

  function flushStreamingContent(streamState: StreamingWidget) {
    if (streamState.finalHTML && !streamState.finalApplied) {
      return sendStreamingContent(streamState, streamState.finalHTML, true);
    }
    if (!streamState.finalHTML && streamState.lastHTML) {
      return sendStreamingContent(streamState, streamState.lastHTML, false);
    }
    return false;
  }

  function streamingPlaceholderHTML() {
    return `<div style="display:grid;gap:0.75rem;min-height:220px;align-content:start">
<div style="font-size:0.95rem;opacity:0.7;letter-spacing:0.08em;text-transform:uppercase">Generating widget</div>
<div style="padding:1rem 1.1rem;border-radius:16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08)">Streaming content into the native window…</div>
</div>`;
  }

  function applyStreamingPlaceholder(streamState: StreamingWidget, force = false) {
    if (streamState.placeholderApplied || streamState.finalApplied) return false;
    if (!force && (streamState.lastHTML || streamState.finalHTML)) return false;
    if (sendStreamingContent(streamState, streamingPlaceholderHTML())) {
      streamState.placeholderApplied = true;
      return true;
    }
    return false;
  }

  function attachStreamingReadyHandler(streamState: StreamingWidget, win: WidgetWindow) {
    win.on("ready", () => {
      if (streaming !== streamState) {
        try { win.close(); } catch {}
        return;
      }
      streamState.ready = true;
      setWidgetTerminalStatus(streamState.title, streamState.width, streamState.height, "generating");

      const shouldForcePlaceholder = !!streamState.finalHTML
        && streamState.lastHTML === streamState.finalHTML
        && !streamState.finalApplied;
      if (applyStreamingPlaceholder(streamState, shouldForcePlaceholder)) {
        if (shouldForcePlaceholder) {
          streamState.delayedFinalPending = true;
          setTimeout(() => {
            streamState.delayedFinalPending = false;
            flushStreamingContent(streamState);
          }, 50);
          return;
        }
      }

      flushStreamingContent(streamState);
    });
  }

  async function startStreamingOpen(streamState: StreamingWidget) {
    if (streamState.window) return streamState.window;
    if (!streamState.opening) {
      setWidgetTerminalStatus(streamState.title, streamState.width, streamState.height, "opening");
      streamState.opening = (async () => {
        const win = await openWidgetWindow(shellHTML(), {
          title: streamState.title,
          width: streamState.width,
          height: streamState.height,
          floating: streamState.floating,
        });
        if (streaming !== streamState) {
          try { win.close(); } catch {}
          throw new Error("Stale streaming window.");
        }
        streamState.window = win;
        attachStreamingReadyHandler(streamState, win);
        return win;
      })();

      try {
        const win = await streamState.opening;
        streamState.opening = null;
        return win;
      } catch (error) {
        streamState.opening = null;
        throw error;
      }
    }
    return await streamState.opening;
  }

  async function waitForStreamingReady(streamState: StreamingWidget, win: WidgetWindow) {
    if (streamState.ready) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      win.on("ready", finish);
      win.on("closed", () => {
        if (settled) return;
        settled = true;
        reject(new Error("Streaming window closed before reporting ready."));
      });
      win.on("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  function queueStreamingOpen(streamState: StreamingWidget) {
    if (streamState.updateTimer) return;
    streamState.updateTimer = setTimeout(async () => {
      streamState.updateTimer = null;

      try {
        if (!streamState.window && !streamState.opening) {
          await startStreamingOpen(streamState);
          return;
        }

        if (streamState.window && streamState.ready) {
          applyStreamingPlaceholder(streamState);
          flushStreamingContent(streamState);
        }
      } catch {}
    }, 150);
  }

  async function closeStreamingWindow(streamState: StreamingWidget | null) {
    if (!streamState) return;
    if (streamState.updateTimer) {
      clearTimeout(streamState.updateTimer);
      streamState.updateTimer = null;
    }

    if (streamState.window) {
      try { streamState.window.close(); } catch {}
      return;
    }

    if (streamState.opening) {
      try {
        const win = await streamState.opening;
        try { win.close(); } catch {}
      } catch {}
    }
  }

  async function abandonStreamingWindow(streamState: StreamingWidget | null) {
    if (!streamState) return;
    if (streaming === streamState) streaming = null;
    clearWidgetTerminalStatus();
    await closeStreamingWindow(streamState);
  }

  async function ensureSupport() {
    const support = await backend.checkSupport();
    if (!support.ok) {
      throw new Error(formatSupportError(backend.kind, support as any));
    }
  }

  async function openWidgetWindow(html: string, options: { title: string; width: number; height: number; floating?: boolean }) {
    await ensureSupport();
    const win = await backend.open(html, options);
    activeWindows.push(win);
    const cleanup = () => {
      activeWindows = activeWindows.filter((window) => window !== win);
    };
    win.on("closed", cleanup);
    win.on("error", cleanup);
    return win;
  }

  pi.on("message_update", async (event) => {
    const raw: any = event.assistantMessageEvent;
    if (!raw) return;

    if (raw.type === "toolcall_start") {
      const partial: any = raw.partial;
      const block = partial?.content?.[raw.contentIndex];
      if (block?.type === "toolCall" && block?.name === "show_widget") {
        const args = block.arguments ?? {};
        const streamState: StreamingWidget = {
          contentIndex: raw.contentIndex,
          window: null,
          lastHTML: "",
          finalHTML: null,
          finalApplied: false,
          updateTimer: null,
          ready: false,
          opening: null,
          placeholderApplied: false,
          delayedFinalPending: false,
          title: normalizeWidgetTitle(args.title ?? "Widget"),
          width: args.width ?? 800,
          height: args.height ?? 600,
          floating: args.floating ?? false,
        };
        streaming = streamState;
        setWidgetTerminalStatus(streamState.title, streamState.width, streamState.height, "preparing");
        queueStreamingOpen(streamState);
      }
      return;
    }

    if (raw.type === "toolcall_delta" && streaming && raw.contentIndex === streaming.contentIndex) {
      const partial: any = raw.partial;
      const block = partial?.content?.[raw.contentIndex];
      const args = block?.arguments ?? {};
      const html = args.widget_code;
      if (!html || html.length < 20 || html === streaming.lastHTML) return;

      streaming.lastHTML = html;
      streaming.title = normalizeWidgetTitle(args.title ?? streaming.title ?? "Widget");
      streaming.width = args.width ?? streaming.width;
      streaming.height = args.height ?? streaming.height;
      streaming.floating = args.floating ?? streaming.floating;
      setWidgetTerminalStatus(streaming.title, streaming.width, streaming.height, "generating");
      queueStreamingOpen(streaming);
      return;
    }

    if (raw.type === "toolcall_end" && streaming && raw.contentIndex === streaming.contentIndex) {
      if (streaming.updateTimer) {
        clearTimeout(streaming.updateTimer);
        streaming.updateTimer = null;
      }

      const toolCall = raw.toolCall;
      if (toolCall?.arguments?.widget_code) {
        streaming.finalHTML = toolCall.arguments.widget_code;
        if (!streaming.window && !streaming.opening) {
          queueStreamingOpen(streaming);
        }
        flushStreamingContent(streaming);
        setWidgetTerminalStatus(streaming.title, streaming.width, streaming.height, "ready");
      }
      return;
    }
  });

  pi.on("message_end", async (event) => {
    const message: any = event.message;
    if (message?.role === "assistant" && message?.stopReason === "aborted") {
      await abandonStreamingWindow(streaming);
    }
  });

  pi.registerTool({
    name: "visualize_read_me",
    label: "Read Guidelines",
    description:
      "Returns design guidelines for show_widget (CSS patterns, colors, typography, layout rules, examples). " +
      "Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.",
    promptSnippet: "Load design guidelines before creating widgets. Call silently before first show_widget use.",
    promptGuidelines: [
      "Call visualize_read_me once before your first show_widget call to load design guidelines.",
      "Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.",
      "Pick the modules that match your use case: interactive, chart, mockup, art, diagram.",
    ],
    parameters: Type.Object({
      modules: Type.Array(
        StringEnum(AVAILABLE_MODULES as readonly string[]),
        { description: "Which module(s) to load. Pick all that fit." }
      ),
    }),

    async execute(_toolCallId, params) {
      hasSeenReadMe = true;
      const content = getGuidelines(params.modules);
      return {
        content: [{ type: "text" as const, text: content }],
        details: { modules: params.modules },
      };
    },

    renderCall(args: any, theme: any) {
      const mods = (args.modules ?? []).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("read_me ")) + theme.fg("muted", mods),
        0, 0
      );
    },

    renderResult(_result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "Loading guidelines..."), 0, 0);
      return new Text(theme.fg("dim", "Guidelines loaded"), 0, 0);
    },
  });

  pi.registerTool({
    name: "show_widget",
    label: "Show Widget",
    description:
      "Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — in a native platform window. " +
      "Use for flowcharts, dashboards, forms, calculators, data tables, games, illustrations, or any visual content. " +
      "The HTML is rendered in a native webview window with full CSS/JS support including Canvas and CDN libraries. " +
      "The page gets a window.glimpse.send(data) bridge to send JSON data back to the agent. " +
      "IMPORTANT: Call visualize_read_me once before your first show_widget call.",
    promptSnippet: "Render interactive HTML/SVG widgets in a native platform window. Supports full CSS, JS, Canvas, Chart.js.",
    promptGuidelines: [
      "Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.",
      "Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.",
      "The widget opens in a native platform window with full browser capabilities (Canvas, JS, CDN libraries).",
      "Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.",
      "The page has window.glimpse.send(data) to send data back. Use it for user choices and interactions.",
      "For chat shortcut buttons, call sendPrompt('your follow-up prompt') or window.glimpse.send({ type: 'follow_up_prompt', prompt: '...' }).",
      "Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.",
      "For interactive explainers: sliders, live calculations, Chart.js charts.",
      "For SVG: start code with <svg> tag, it will be auto-detected.",
      "Be concise in your responses",
    ],
    parameters: Type.Object({
      i_have_seen_read_me: Type.Boolean({
        description: "Confirm you have already called visualize_read_me in this conversation.",
      }),
      title: Type.String({
        description: "Short snake_case identifier for this widget (used as window title).",
      }),
      widget_code: Type.String({
        description:
          "HTML or SVG code to render. For SVG: raw SVG starting with <svg>. " +
          "For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
      }),
      width: Type.Optional(Type.Number({ description: "Window width in pixels. Default: 800." })),
      height: Type.Optional(Type.Number({ description: "Window height in pixels. Default: 600." })),
      floating: Type.Optional(Type.Boolean({ description: "Keep window always on top. Default: false." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      if (!params.i_have_seen_read_me) {
        throw new Error("You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.");
      }

      hasSeenReadMe = true;
      const code = params.widget_code;
      const isSVG = code.trimStart().startsWith("<svg");
      const title = normalizeWidgetTitle(params.title);
      const width = params.width ?? 800;
      const height = params.height ?? 600;
      let win: WidgetWindow | null = null;

      const emitPartialStatus = (phase: "opening" | "ready") => {
        onUpdate?.({
          content: [{
            type: "text" as const,
            text: phase === "ready"
              ? `Widget finished generating. Waiting for interaction or window close (${title}, ${width}×${height}).`
              : `Opening widget window (${title}, ${width}×${height})...`,
          }],
          details: {
            title: params.title,
            width,
            height,
            isSVG,
            phase,
          },
        });
      };

      const streamState = streaming;
      if (streamState) {
        if (streamState.updateTimer) {
          clearTimeout(streamState.updateTimer);
          streamState.updateTimer = null;
        }
        streamState.finalHTML = streamState.finalHTML ?? code;
        win = streamState.window ?? await startStreamingOpen(streamState);
        await waitForStreamingReady(streamState, win);
        streamState.window = win;
        if (!streamState.delayedFinalPending) {
          flushStreamingContent(streamState);
        }
        setWidgetTerminalStatus(title, width, height, "ready");
        emitPartialStatus("ready");
        streaming = null;
      } else {
        setWidgetTerminalStatus(title, width, height, "opening");
        emitPartialStatus("opening");
        win = await openWidgetWindow(wrapHTML(code, isSVG), {
          width,
          height,
          title,
          floating: params.floating ?? false,
        });
        setWidgetTerminalStatus(title, width, height, "ready");
        emitPartialStatus("ready");
      }

      return new Promise<any>((resolve, reject) => {
        if (!win) {
          reject(new Error("Failed to open widget window."));
          return;
        }

        let messageData: any = null;
        let followUpPrompt: string | null = null;
        let followUpReplyMode: "followUp" | "steer" | null = null;
        let resolved = false;
        const timeout = setTimeout(() => {
          finish("Widget still open (timed out waiting for interaction).");
        }, 120_000);

        const finish = (reason: string) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          clearWidgetTerminalStatus();
          activeWindows = activeWindows.filter((window) => window !== win);
          resolve({
            content: [
              {
                type: "text" as const,
                text: followUpPrompt
                  ? `Widget queued follow-up prompt: ${JSON.stringify(followUpPrompt)}`
                  : messageData
                    ? `Widget rendered. User interaction data: ${JSON.stringify(messageData)}`
                    : `Widget "${title}" rendered and shown to the user (${width}×${height}). ${reason}`,
              },
            ],
            details: {
              title: params.title,
              width,
              height,
              isSVG,
              messageData,
              followUpPrompt,
              followUpReplyMode,
              closedReason: reason,
            },
          });
        };

        win.on("message", async (data: unknown) => {
          messageData = data;
          const promptMessage = extractFollowUpPromptMessage(data);
          if (promptMessage) {
            followUpPrompt = promptMessage.prompt;
            followUpReplyMode = promptMessage.replyMode ?? "followUp";
            try {
              pi.sendUserMessage(promptMessage.prompt, { deliverAs: followUpReplyMode });
              finish(`Queued follow-up prompt (${followUpReplyMode}).`);
            } catch (error) {
              clearWidgetTerminalStatus();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          finish("User sent data from widget.");
        });

        win.on("closed", () => {
          finish("Window closed by user.");
        });

        win.on("error", (err: unknown) => {
          clearWidgetTerminalStatus();
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            try { win?.close(); } catch {}
            finish("Aborted.");
          }, { once: true });
        }
      });
    },

    renderCall(args: any, theme: any) {
      const title = normalizeWidgetTitle(args.title ?? "widget");
      const width = args.width ?? 800;
      const height = args.height ?? 600;
      const phase = getWidgetTerminalPhase({ ...args, title, width, height });
      const size = ` ${width}×${height}`;
      let text = theme.fg("toolTitle", theme.bold("show_widget "));
      text += theme.fg("accent", title);
      text += theme.fg("dim", size);
      if (phase === "preparing") text += theme.fg("warning", " [preparing]");
      if (phase === "generating") text += theme.fg("warning", " [generating]");
      if (phase === "opening") text += theme.fg("warning", " [opening]");
      if (phase === "ready") text += theme.fg("success", " [finished, waiting]");
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial, expanded }: any, theme: any) {
      const details = result.details ?? {};

      if (isPartial) {
        const phase = details.phase;
        if (phase === "opening") {
          return new Text(theme.fg("warning", "⟳ Opening widget window..."), 0, 0);
        }
        if (phase === "ready") {
          return new Text(theme.fg("success", "✓ Widget finished generating — waiting for interaction or window close"), 0, 0);
        }
        return new Text(theme.fg("warning", "⟳ Widget generating..."), 0, 0);
      }

      const contentText = (result.content ?? [])
        .filter((item: any) => item?.type === "text" && typeof item.text === "string")
        .map((item: any) => item.text)
        .join("\n")
        .trim();

      const looksLikeError = typeof details.title !== "string" && contentText.startsWith("Backend:");
      if (looksLikeError) {
        let text = theme.fg("error", "✗ Widget error");
        if (contentText) text += "\n" + theme.fg("muted", `  ${contentText.replace(/\n/g, "\n  ")}`);
        return new Text(text, 0, 0);
      }

      const title = (details.title ?? "widget").replace(/_/g, " ");
      let text = theme.fg("success", "✓ ") + theme.fg("accent", title);
      text += theme.fg("dim", ` ${details.width ?? 800}×${details.height ?? 600}`);
      if (details.isSVG) text += theme.fg("dim", " (SVG)");

      if (details.closedReason) text += "\n" + theme.fg("muted", `  ${details.closedReason}`);
      if (details.followUpPrompt) {
        text += "\n" + theme.fg("dim", `  Queued prompt: ${details.followUpPrompt}`);
      }
      if (details.messageData !== undefined) {
        const messageText = expanded
          ? JSON.stringify(details.messageData, null, 2)
          : JSON.stringify(details.messageData);
        text += "\n" + theme.fg("dim", `  Data: ${messageText}`);
      }

      return new Text(text, 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    if (streaming?.updateTimer) clearTimeout(streaming.updateTimer);
    streaming = null;
    clearWidgetTerminalStatus();
    for (const win of activeWindows) {
      try { win.close(); } catch {}
    }
    activeWindows = [];
  });
}
