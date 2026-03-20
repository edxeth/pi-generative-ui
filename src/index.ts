import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { getGuidelines, AVAILABLE_MODULES } from "./guidelines.js";
import { SVG_STYLES } from "./svg-styles.js";
import { getWidgetBackend, formatSupportError, type WidgetWindow } from "./backend/index.js";

interface FollowUpPromptMessage {
  type: "follow_up_prompt";
  prompt: string;
  replyMode?: "followUp" | "steer";
}

interface WidgetTraceMessage {
  type: "__pi_widget_trace";
  phase: string;
  data?: unknown;
  at?: number;
}

interface WidgetTraceEntry {
  source: "host" | "widget";
  phase: string;
  at: string;
  elapsedMs: number;
  data?: unknown;
}

interface WidgetTraceCarrier {
  traceStartedAt: number;
  debugTrace: WidgetTraceEntry[];
}

const DEBUG_TRACE_ENABLED = process.env.PI_GENERATIVE_UI_DEBUG === "1";
const DEBUG_STDERR_ENABLED = process.env.PI_GENERATIVE_UI_DEBUG_STDERR === "1";
const MIN_PLACEHOLDER_VISIBLE_MS = 220;
const SCRIPT_STAGE_DELAY_MS = 40;

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= 3) return "[max-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeTraceValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
    return Object.fromEntries(entries.map(([key, item]) => [key, sanitizeTraceValue(item, depth + 1)]));
  }
  return String(value);
}

function pushTrace(target: WidgetTraceCarrier | null | undefined, source: "host" | "widget", phase: string, data?: unknown) {
  if (!target) return;
  const entry: WidgetTraceEntry = {
    source,
    phase,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - target.traceStartedAt,
  };
  const sanitized = sanitizeTraceValue(data);
  if (sanitized !== undefined) {
    entry.data = sanitized;
  }
  target.debugTrace.push(entry);
  if (DEBUG_STDERR_ENABLED) {
    const suffix = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
    console.error(`[pi-generative-ui] ${entry.elapsedMs}ms ${source}:${phase}${suffix}`);
  }
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
  window.__piWidgetTrace = function(phase, data) {
    if (!window.glimpse || typeof window.glimpse.send !== 'function') return;
    if (typeof phase !== 'string' || !phase) return;
    window.glimpse.send({
      type: '__pi_widget_trace',
      phase: phase,
      data: data == null ? null : data,
      at: Date.now()
    });
  };
  if (Array.isArray(window.__PI_WIDGET_PENDING_TRACES__)) {
    window.__PI_WIDGET_PENDING_TRACES__.forEach(function(entry) {
      if (!Array.isArray(entry) || entry.length < 1) return;
      window.__piWidgetTrace(entry[0], entry[1]);
    });
    window.__PI_WIDGET_PENDING_TRACES__ = [];
  }
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

function extractWidgetTraceMessage(data: unknown): WidgetTraceMessage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "__pi_widget_trace") return null;
  if (typeof record.phase !== "string" || !record.phase) return null;
  return {
    type: "__pi_widget_trace",
    phase: record.phase,
    data: record.data,
    at: typeof record.at === "number" ? record.at : undefined,
  };
}

// Shell HTML with a root container — used for streaming.
// Content is injected via win.send() JS eval, not a full reload, to avoid flashes.
function shellHTML(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{box-sizing:border-box}
body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;position:relative;}
@keyframes _fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@keyframes _pulse{0%,100%{opacity:.45}50%{opacity:1}}
#pi-loading{position:sticky;top:0;display:none;align-items:center;gap:10px;padding:0 0 12px;pointer-events:none;z-index:9999}
#pi-loading[data-visible="1"]{display:flex}
#pi-loading-badge{display:inline-flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.08);border-radius:999px;background:rgba(26,26,26,.88);padding:10px 14px;max-width:min(100%,560px)}
#pi-loading-spinner{width:12px;height:12px;border-radius:999px;border:2px solid rgba(255,255,255,.18);border-top-color:rgba(255,255,255,.9);animation:_spin .8s linear infinite}
#pi-loading-text{display:grid;gap:2px;min-width:0}
#pi-loading-title{font-size:.92rem;letter-spacing:.02em;opacity:.95}
#pi-loading-subtitle{font-size:.82rem;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes _spin{to{transform:rotate(360deg)}}
${SVG_STYLES}
</style>
</head><body><div id="pi-loading" aria-hidden="true"><div id="pi-loading-badge"><div id="pi-loading-spinner"></div><div id="pi-loading-text"><div id="pi-loading-title">Generating UI…</div><div id="pi-loading-subtitle">Waiting for streamed HTML and startup scripts…</div></div></div></div><div id="root"></div>
<script>
  window._morphReady = false;
  window._pending = null;
  window._loadingTimer = null;
  window._loadingVisible = false;
  window.__PI_WIDGET_PENDING_TRACES__ = [];
  window.piGenerativeUiStreamingMetrics = { contentUpdates: 0, scriptRuns: 0 };
  window.__PI_GENERATIVE_UI_STREAMING_METRICS__ = window.piGenerativeUiStreamingMetrics;
  window._trace = function(phase, data) {
    if (typeof window.__piWidgetTrace === 'function') {
      window.__piWidgetTrace(phase, data == null ? null : data);
      return;
    }
    window.__PI_WIDGET_PENDING_TRACES__.push([phase, data == null ? null : data]);
  };
  window._trace('shell_boot', { readyState: document.readyState });
  window.addEventListener('error', function(event) {
    window._trace('window_error', {
      message: event && event.message ? String(event.message) : 'Unknown error',
      source: event && event.filename ? String(event.filename) : null,
      line: event && typeof event.lineno === 'number' ? event.lineno : null
    });
  });
  window.addEventListener('unhandledrejection', function(event) {
    var reason = event && 'reason' in event ? event.reason : null;
    window._trace('window_unhandled_rejection', {
      reason: reason && reason.message ? String(reason.message) : String(reason)
    });
  });
  window._setLoading = function(visible, subtitle) {
    var loading = document.getElementById('pi-loading');
    var text = document.getElementById('pi-loading-subtitle');
    if (!loading) return;
    loading.dataset.visible = visible ? '1' : '0';
    if (subtitle && text) text.textContent = subtitle;
    if (window._loadingVisible !== !!visible) {
      window._loadingVisible = !!visible;
      window._trace(visible ? 'loading_shown' : 'loading_hidden', { subtitle: subtitle || null });
    }
  };
  window._scheduleLoading = function(subtitle) {
    clearTimeout(window._loadingTimer);
    window._loadingTimer = setTimeout(function() {
      window._setLoading(true, subtitle || 'Rendering charts, scripts, and controls…');
    }, 180);
  };
  window._hideLoading = function() {
    clearTimeout(window._loadingTimer);
    window._setLoading(false);
  };
  window._needsLoading = function(html) {
    if (typeof html !== 'string') return false;
    return /<script[\s>]/i.test(html) || /<canvas[\s>]/i.test(html);
  };
  window._snapshotDom = function(phase) {
    var root = document.getElementById('root');
    if (!root) return;
    var canvases = Array.from(root.querySelectorAll('canvas')).slice(0, 4).map(function(canvas) {
      return {
        id: canvas.id || null,
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight
      };
    });
    window._trace('dom_snapshot', {
      phase: phase,
      elements: root.querySelectorAll('*').length,
      textLength: root.textContent ? root.textContent.trim().length : 0,
      inputs: root.querySelectorAll('input').length,
      selects: root.querySelectorAll('select').length,
      buttons: root.querySelectorAll('button').length,
      canvases: canvases,
      headings: Array.from(root.querySelectorAll('h1,h2,h3')).slice(0, 3).map(function(el) {
        return (el.textContent || '').trim();
      })
    });
  };
  window._setContent = function(html) {
    if (!window._morphReady) {
      window._pending = html;
      window._trace('set_content_buffered', { htmlLength: typeof html === 'string' ? html.length : 0 });
      return;
    }
    var needsLoading = window._needsLoading(html);
    window._trace('set_content', {
      htmlLength: typeof html === 'string' ? html.length : 0,
      needsLoading: needsLoading,
      hasCanvas: /<canvas[\s>]/i.test(html || ''),
      hasScripts: /<script[\s>]/i.test(html || '')
    });
    if (needsLoading) {
      window._scheduleLoading('Streaming widget structure…');
    } else if (window.__PI_GENERATIVE_UI_STREAMING_METRICS__.scriptRuns === 0) {
      window._hideLoading();
    }
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
    requestAnimationFrame(function() {
      window._snapshotDom('after_set_content');
    });
  };
  window._setContentAndStageScripts = function(html, delayMs) {
    var delay = typeof delayMs === 'number' ? delayMs : 0;
    window._trace('stage_scripts_requested', { delayMs: delay, htmlLength: typeof html === 'string' ? html.length : 0 });
    window._setContent(html);
    var run = function() {
      window._trace('stage_scripts_running');
      window._runScripts();
    };
    var schedule = function() {
      requestAnimationFrame(function() {
        requestAnimationFrame(run);
      });
    };
    if (delay > 0) {
      setTimeout(schedule, delay);
      return;
    }
    schedule();
  };
  window._runScripts = function() {
    window.__PI_GENERATIVE_UI_STREAMING_METRICS__.scriptRuns += 1;
    var scripts = Array.from(document.querySelectorAll('#root script'));
    window._trace('run_scripts_start', { count: scripts.length });
    if (!scripts.length) {
      window._trace('run_scripts_complete', { count: 0 });
      window._hideLoading();
      return;
    }
    window._scheduleLoading();
    var pending = 0;
    var finished = false;
    function complete() {
      if (finished) return;
      finished = true;
      window._trace('run_scripts_complete', { pending: pending });
      requestAnimationFrame(function() {
        window._snapshotDom('after_run_scripts');
        requestAnimationFrame(function() {
          window._hideLoading();
        });
      });
    }
    function checkDone() {
      if (pending === 0) complete();
    }
    scripts.forEach(function(old, index) {
      var s = document.createElement('script');
      Array.from(old.attributes).forEach(function(attr) {
        s.setAttribute(attr.name, attr.value);
      });
      if (old.src) {
        pending += 1;
        window._trace('external_script_requested', { index: index, src: old.src });
        s.addEventListener('load', function() {
          pending -= 1;
          window._trace('external_script_loaded', { index: index, src: old.src });
          checkDone();
        });
        s.addEventListener('error', function() {
          pending -= 1;
          window._trace('external_script_failed', { index: index, src: old.src });
          checkDone();
        });
      } else {
        s.textContent = old.textContent;
        window._trace('inline_script_replaced', { index: index, length: old.textContent ? old.textContent.length : 0 });
      }
      old.parentNode.replaceChild(s, old);
    });
    checkDone();
  };
</script>
${widgetBridgeScript()}
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;window._trace('morphdom_ready');if(window._pending){window._setContent(window._pending);window._pending=null;}"></script>
</body></html>`;
}

// Wrap HTML fragment into a full document for non-streaming fallback.
function wrapHTML(code: string, isSVG = false): string {
  if (isSVG) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SVG_STYLES}</style></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}
${widgetBridgeScript()}</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0}${SVG_STYLES}</style>
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
  let activeWidgetRuns: Array<() => void> = [];

  interface StreamingWidget extends WidgetTraceCarrier {
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
    sawToolCallDelta: boolean;
    lastWindowTitle: string | null;
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

  function getWindowTitle(title: string, phase: WidgetTerminalPhase | "placeholder") {
    const normalized = normalizeWidgetTitle(title);
    if (phase === "placeholder") return "Generating UI…";
    if (phase === "preparing" || phase === "generating" || phase === "opening") {
      return `${normalized} · Generating UI…`;
    }
    return normalized;
  }

  function syncWindowTitle(streamState: StreamingWidget, phase: WidgetTerminalPhase | "placeholder") {
    if (!streamState.window || typeof streamState.window.show !== "function") return;
    const title = getWindowTitle(streamState.title, phase);
    if (streamState.lastWindowTitle === title) return;
    try {
      streamState.window.show({ title });
      streamState.lastWindowTitle = title;
      pushTrace(streamState, "host", "window_title_updated", { title, phase });
    } catch (error) {
      pushTrace(streamState, "host", "window_title_update_failed", error);
    }
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
    pushTrace(streamState, "host", runScripts ? "send_final_content" : "send_streaming_content", {
      htmlLength: html.length,
      runScripts,
    });
    streamState.window.send(runScripts
      ? `window._setContentAndStageScripts('${escaped}', ${SCRIPT_STAGE_DELAY_MS});`
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
      pushTrace(streamState, "host", "flush_final_content", { htmlLength: streamState.finalHTML.length });
      return sendStreamingContent(streamState, streamState.finalHTML, true);
    }
    if (!streamState.finalHTML && streamState.lastHTML) {
      pushTrace(streamState, "host", "flush_partial_content", { htmlLength: streamState.lastHTML.length });
      return sendStreamingContent(streamState, streamState.lastHTML, false);
    }
    pushTrace(streamState, "host", "flush_skipped", {
      hasFinalHTML: !!streamState.finalHTML,
      hasLastHTML: !!streamState.lastHTML,
      finalApplied: streamState.finalApplied,
    });
    return false;
  }

  function streamingPlaceholderHTML() {
    return `<div style="padding:0.35rem 0 0.25rem;color:rgba(255,255,255,.7);font-size:.92rem">Generating UI…</div>`;
  }

  function applyStreamingPlaceholder(streamState: StreamingWidget, force = false) {
    if (streamState.placeholderApplied || streamState.finalApplied) return false;
    if (!force && (streamState.lastHTML || streamState.finalHTML)) return false;
    if (sendStreamingContent(streamState, streamingPlaceholderHTML())) {
      streamState.placeholderApplied = true;
      pushTrace(streamState, "host", "placeholder_applied", { force });
      return true;
    }
    pushTrace(streamState, "host", "placeholder_skipped", {
      force,
      hasLastHTML: !!streamState.lastHTML,
      hasFinalHTML: !!streamState.finalHTML,
      finalApplied: streamState.finalApplied,
    });
    return false;
  }

  function attachStreamingReadyHandler(streamState: StreamingWidget, win: WidgetWindow) {
    win.on("ready", () => {
      if (streaming !== streamState) {
        pushTrace(streamState, "host", "window_ready_stale");
        try { win.close(); } catch {}
        return;
      }
      streamState.ready = true;
      pushTrace(streamState, "host", "window_ready");
      setWidgetTerminalStatus(streamState.title, streamState.width, streamState.height, "generating");
      syncWindowTitle(streamState, streamState.sawToolCallDelta ? "generating" : "placeholder");

      const shouldDelayFinal = !!streamState.finalHTML && !streamState.sawToolCallDelta && !streamState.finalApplied;
      if (applyStreamingPlaceholder(streamState, shouldDelayFinal)) {
        if (shouldDelayFinal) {
          streamState.delayedFinalPending = true;
          pushTrace(streamState, "host", "delay_final_after_placeholder", { delayMs: MIN_PLACEHOLDER_VISIBLE_MS });
          setTimeout(() => {
            streamState.delayedFinalPending = false;
            pushTrace(streamState, "host", "delayed_final_released");
            flushStreamingContent(streamState);
          }, MIN_PLACEHOLDER_VISIBLE_MS);
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
      pushTrace(streamState, "host", "open_window_start", {
        title: streamState.title,
        width: streamState.width,
        height: streamState.height,
        floating: streamState.floating,
      });
      streamState.opening = (async () => {
        const win = await openWidgetWindow(shellHTML(), {
          title: getWindowTitle(streamState.title, "placeholder"),
          width: streamState.width,
          height: streamState.height,
          floating: streamState.floating,
        });
        pushTrace(streamState, "host", "open_window_resolved");
        if (streaming !== streamState) {
          pushTrace(streamState, "host", "open_window_stale");
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
        pushTrace(streamState, "host", "open_window_failed", error);
        throw error;
      }
    }
    return await streamState.opening;
  }

  async function waitForStreamingReady(streamState: StreamingWidget, win: WidgetWindow) {
    if (streamState.ready) return;
    pushTrace(streamState, "host", "wait_for_streaming_ready_start");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pushTrace(streamState, "host", "wait_for_streaming_ready_done");
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
    pushTrace(streamState, "host", "queue_streaming_open", { delayMs: 150 });
    streamState.updateTimer = setTimeout(async () => {
      streamState.updateTimer = null;
      pushTrace(streamState, "host", "queue_streaming_open_fired", {
        hasWindow: !!streamState.window,
        ready: streamState.ready,
      });

      try {
        if (!streamState.window && !streamState.opening) {
          await startStreamingOpen(streamState);
          return;
        }

        if (streamState.window && streamState.ready) {
          applyStreamingPlaceholder(streamState);
          flushStreamingContent(streamState);
        }
      } catch (error) {
        pushTrace(streamState, "host", "queue_streaming_open_failed", error);
      }
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

  function abortActiveWidgetRuns() {
    const runs = activeWidgetRuns;
    activeWidgetRuns = [];
    for (const abort of runs) {
      try { abort(); } catch {}
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

  async function waitForWindowReady(win: WidgetWindow) {
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
        reject(new Error("Widget window closed before reporting ready."));
      });
      win.on("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  function nonStreamingContent(code: string, isSVG: boolean) {
    if (!isSVG) return code;
    return `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;">${code}</div>`;
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
          traceStartedAt: Date.now(),
          debugTrace: [],
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
          sawToolCallDelta: false,
          lastWindowTitle: null,
          title: normalizeWidgetTitle(args.title ?? "Widget"),
          width: args.width ?? 800,
          height: args.height ?? 600,
          floating: args.floating ?? false,
        };
        pushTrace(streamState, "host", "toolcall_start", {
          contentIndex: raw.contentIndex,
          title: streamState.title,
          width: streamState.width,
          height: streamState.height,
          floating: streamState.floating,
        });
        streaming = streamState;
        setWidgetTerminalStatus(streamState.title, streamState.width, streamState.height, "preparing");
        pushTrace(streamState, "host", "eager_open_requested");
        startStreamingOpen(streamState).catch((error) => {
          pushTrace(streamState, "host", "eager_open_failed", error);
        });
      }
      return;
    }

    if (raw.type === "toolcall_delta" && streaming && raw.contentIndex === streaming.contentIndex) {
      const partial: any = raw.partial;
      const block = partial?.content?.[raw.contentIndex];
      const args = block?.arguments ?? {};
      const html = args.widget_code;
      if (!html || html.length < 20 || html === streaming.lastHTML) return;

      streaming.sawToolCallDelta = true;
      streaming.lastHTML = html;
      streaming.title = normalizeWidgetTitle(args.title ?? streaming.title ?? "Widget");
      streaming.width = args.width ?? streaming.width;
      streaming.height = args.height ?? streaming.height;
      streaming.floating = args.floating ?? streaming.floating;
      pushTrace(streaming, "host", "toolcall_delta", {
        htmlLength: html.length,
        title: streaming.title,
        width: streaming.width,
        height: streaming.height,
      });
      setWidgetTerminalStatus(streaming.title, streaming.width, streaming.height, "generating");
      syncWindowTitle(streaming, "generating");
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
        const finalHTML = toolCall.arguments.widget_code;
        streaming.finalHTML = finalHTML;
        pushTrace(streaming, "host", "toolcall_end", {
          htmlLength: finalHTML.length,
          sawToolCallDelta: streaming.sawToolCallDelta,
        });
        syncWindowTitle(streaming, "ready");
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
      abortActiveWidgetRuns();
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

      const streamState = streaming;
      const traceCarrier: WidgetTraceCarrier = streamState ?? {
        traceStartedAt: Date.now(),
        debugTrace: [],
      };
      pushTrace(traceCarrier, "host", "execute_start", {
        title,
        width,
        height,
        isSVG,
        hasStreamingState: !!streamState,
      });

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

      if (streamState) {
        pushTrace(traceCarrier, "host", "execute_attach_streaming_state", {
          sawToolCallDelta: streamState.sawToolCallDelta,
          hasFinalHTML: !!streamState.finalHTML,
          hasWindow: !!streamState.window,
        });
        if (streamState.updateTimer) {
          clearTimeout(streamState.updateTimer);
          streamState.updateTimer = null;
        }
        streamState.finalHTML = streamState.finalHTML ?? code;
        win = streamState.window ?? await startStreamingOpen(streamState);
        await waitForStreamingReady(streamState, win);
        streamState.window = win;
        syncWindowTitle(streamState, streamState.delayedFinalPending ? "generating" : "ready");
        if (!streamState.delayedFinalPending) {
          flushStreamingContent(streamState);
        }
        setWidgetTerminalStatus(title, width, height, "ready");
        emitPartialStatus("ready");
        streaming = null;
      } else {
        setWidgetTerminalStatus(title, width, height, "opening");
        emitPartialStatus("opening");
        pushTrace(traceCarrier, "host", "nonstream_open_start", {
          width,
          height,
          floating: params.floating ?? false,
        });
        win = await openWidgetWindow(shellHTML(), {
          width,
          height,
          title,
          floating: params.floating ?? false,
        });
        pushTrace(traceCarrier, "host", "nonstream_open_resolved");
        await waitForWindowReady(win);
        if (typeof win.show === "function") {
          try { win.show({ title: `${title} · Generating UI…` }); } catch {}
        }
        pushTrace(traceCarrier, "host", "nonstream_window_ready");
        win.send(`window._setContent('${escapeJS(streamingPlaceholderHTML())}')`);
        pushTrace(traceCarrier, "host", "nonstream_placeholder_sent", { delayMs: MIN_PLACEHOLDER_VISIBLE_MS });
        await new Promise((resolve) => setTimeout(resolve, MIN_PLACEHOLDER_VISIBLE_MS));
        win.send(`window._setContentAndStageScripts('${escapeJS(nonStreamingContent(code, isSVG))}', ${SCRIPT_STAGE_DELAY_MS});`);
        if (typeof win.show === "function") {
          try { win.show({ title }); } catch {}
        }
        pushTrace(traceCarrier, "host", "nonstream_final_staged", { htmlLength: code.length });
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
        const abortRun = () => {
          pushTrace(traceCarrier, "host", "abort_requested");
          try { win?.close(); } catch {}
          finish("Aborted.");
        };
        activeWidgetRuns.push(abortRun);
        const timeout = setTimeout(() => {
          pushTrace(traceCarrier, "host", "interaction_timeout");
          finish("Widget still open (timed out waiting for interaction).");
        }, 120_000);

        const finish = (reason: string) => {
          if (resolved) return;
          resolved = true;
          pushTrace(traceCarrier, "host", "finish", {
            reason,
            hasMessageData: messageData !== null,
            hasFollowUpPrompt: !!followUpPrompt,
          });
          clearTimeout(timeout);
          activeWidgetRuns = activeWidgetRuns.filter((run) => run !== abortRun);
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
              debugTrace: traceCarrier.debugTrace,
            },
          });
        };

        win.on("message", async (data: unknown) => {
          const traceMessage = extractWidgetTraceMessage(data);
          if (traceMessage) {
            pushTrace(traceCarrier, "widget", traceMessage.phase, traceMessage.data);
            return;
          }

          messageData = data;
          pushTrace(traceCarrier, "widget", "message", data);
          const promptMessage = extractFollowUpPromptMessage(data);
          if (promptMessage) {
            followUpPrompt = promptMessage.prompt;
            followUpReplyMode = promptMessage.replyMode ?? "followUp";
            try {
              pi.sendUserMessage(promptMessage.prompt, { deliverAs: followUpReplyMode });
              finish(`Queued follow-up prompt (${followUpReplyMode}).`);
            } catch (error) {
              clearWidgetTerminalStatus();
              pushTrace(traceCarrier, "host", "follow_up_failed", error);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          finish("User sent data from widget.");
        });

        win.on("closed", () => {
          pushTrace(traceCarrier, "host", "window_closed");
          finish("Window closed by user.");
        });

        win.on("error", (err: unknown) => {
          clearWidgetTerminalStatus();
          pushTrace(traceCarrier, "host", "window_error", err);
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        if (signal) {
          signal.addEventListener("abort", abortRun, { once: true });
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
      if (expanded && Array.isArray(details.debugTrace) && details.debugTrace.length) {
        const traceText = details.debugTrace
          .slice(-12)
          .map((entry: any) => {
            const dataText = entry?.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
            return `[${entry?.elapsedMs ?? "?"}ms] ${entry?.source ?? "?"}:${entry?.phase ?? "?"}${dataText}`;
          })
          .join("\n");
        text += "\n" + theme.fg("dim", `  Trace:\n  ${traceText.replace(/\n/g, "\n  ")}`);
      }

      return new Text(text, 0, 0);
    },
  });

  pi.on("session_shutdown", async () => {
    if (streaming?.updateTimer) clearTimeout(streaming.updateTimer);
    streaming = null;
    abortActiveWidgetRuns();
    clearWidgetTerminalStatus();
    for (const win of activeWindows) {
      try { win.close(); } catch {}
    }
    activeWindows = [];
  });
}
