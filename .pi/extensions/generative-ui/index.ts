import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { getGuidelines, AVAILABLE_MODULES } from "./guidelines.js";
import { getWidgetBackend, formatSupportError, type WidgetWindow } from "./backend/index.js";

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
  window._setContent = function(html) {
    if (!window._morphReady) { window._pending = html; return; }
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
    document.querySelectorAll('#root script').forEach(function(old) {
      var s = document.createElement('script');
      if (old.src) { s.src = old.src; } else { s.textContent = old.textContent; }
      old.parentNode.replaceChild(s, old);
    });
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;if(window._pending){window._setContent(window._pending);window._pending=null;}"></script>
</body></html>`;
}

// Wrap HTML fragment into a full document for non-streaming fallback.
function wrapHTML(code: string, isSVG = false): string {
  if (isSVG) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0}</style>
</head><body>${code}</body></html>`;
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
    updateTimer: NodeJS.Timeout | null;
    ready: boolean;
    opening: Promise<WidgetWindow> | null;
    title: string;
    width: number;
    height: number;
    floating: boolean;
  }

  let streaming: StreamingWidget | null = null;

  async function ensureSupport() {
    const support = await backend.checkSupport();
    if (!support.ok) throw new Error(formatSupportError(backend.kind, support));
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
        streaming = {
          contentIndex: raw.contentIndex,
          window: null,
          lastHTML: "",
          updateTimer: null,
          ready: false,
          opening: null,
          title: (args.title ?? "Widget").replace(/_/g, " "),
          width: args.width ?? 800,
          height: args.height ?? 600,
          floating: args.floating ?? false,
        };
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
      streaming.title = (args.title ?? streaming.title ?? "Widget").replace(/_/g, " ");
      streaming.width = args.width ?? streaming.width;
      streaming.height = args.height ?? streaming.height;
      streaming.floating = args.floating ?? streaming.floating;

      if (streaming.updateTimer) return;
      streaming.updateTimer = setTimeout(async () => {
        if (!streaming) return;
        streaming.updateTimer = null;

        try {
          if (!streaming.window && !streaming.opening) {
            streaming.opening = openWidgetWindow(shellHTML(), {
              title: streaming.title,
              width: streaming.width,
              height: streaming.height,
              floating: streaming.floating,
            });

            const win = await streaming.opening;
            if (!streaming) return;
            streaming.window = win;
            streaming.opening = null;

            win.on("ready", () => {
              if (!streaming || streaming.window !== win) return;
              streaming.ready = true;
              const escaped = escapeJS(streaming.lastHTML);
              win.send(`window._setContent('${escaped}')`);
            });
          } else if (streaming.window && streaming.ready) {
            const escaped = escapeJS(streaming.lastHTML);
            streaming.window.send(`window._setContent('${escaped}')`);
          }
        } catch {
          if (streaming) streaming.opening = null;
        }
      }, 150);
      return;
    }

    if (raw.type === "toolcall_end" && streaming && raw.contentIndex === streaming.contentIndex) {
      if (streaming.updateTimer) {
        clearTimeout(streaming.updateTimer);
        streaming.updateTimer = null;
      }

      const toolCall = raw.toolCall;
      if (toolCall?.arguments?.widget_code && streaming.window && streaming.ready) {
        const escaped = escapeJS(toolCall.arguments.widget_code);
        streaming.window.send(`window._setContent('${escaped}'); window._runScripts();`);
      }
      return;
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

    async execute(_toolCallId, params, signal) {
      if (!params.i_have_seen_read_me) {
        throw new Error("You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.");
      }

      hasSeenReadMe = true;
      const code = params.widget_code;
      const isSVG = code.trimStart().startsWith("<svg");
      const title = params.title.replace(/_/g, " ");
      const width = params.width ?? 800;
      const height = params.height ?? 600;
      let win: WidgetWindow | null = null;

      if (streaming?.window) {
        win = streaming.window;
        if (streaming.ready) {
          const escaped = escapeJS(code);
          win.send(`window._setContent('${escaped}'); window._runScripts();`);
        }
        streaming = null;
      } else {
        win = await openWidgetWindow(wrapHTML(code, isSVG), {
          width,
          height,
          title,
          floating: params.floating ?? false,
        });
      }

      return new Promise<any>((resolve, reject) => {
        if (!win) {
          reject(new Error("Failed to open widget window."));
          return;
        }

        let messageData: any = null;
        let resolved = false;
        const timeout = setTimeout(() => {
          finish("Widget still open (timed out waiting for interaction).");
        }, 120_000);

        const finish = (reason: string) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          activeWindows = activeWindows.filter((window) => window !== win);
          resolve({
            content: [
              {
                type: "text" as const,
                text: messageData
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
              closedReason: reason,
            },
          });
        };

        win.on("message", (data: unknown) => {
          messageData = data;
          finish("User sent data from widget.");
        });

        win.on("closed", () => {
          finish("Window closed by user.");
        });

        win.on("error", (err: unknown) => {
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
      const title = (args.title ?? "widget").replace(/_/g, " ");
      const size = args.width && args.height ? ` ${args.width}×${args.height}` : "";
      let text = theme.fg("toolTitle", theme.bold("show_widget "));
      text += theme.fg("accent", title);
      if (size) text += theme.fg("dim", size);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial, expanded }: any, theme: any) {
      if (isPartial) {
        return new Text(theme.fg("warning", "⟳ Widget rendering..."), 0, 0);
      }

      const details = result.details ?? {};
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
    for (const win of activeWindows) {
      try { win.close(); } catch {}
    }
    activeWindows = [];
  });
}
