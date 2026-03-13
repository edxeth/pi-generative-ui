import type { WidgetBackend } from "./types.js";
import { GlimpseBackend } from "./glimpse.js";
import { LinuxWebviewBackend } from "./linux.js";

let backend: WidgetBackend | null = null;

export function getWidgetBackend(): WidgetBackend {
  if (backend) return backend;

  if (process.platform === "darwin") {
    backend = new GlimpseBackend();
    return backend;
  }

  if (process.platform === "linux") {
    backend = new LinuxWebviewBackend();
    return backend;
  }

  backend = {
    kind: "linux-webview",
    async checkSupport() {
      return {
        ok: false as const,
        code: "UNSUPPORTED_PLATFORM" as const,
        reason: `Platform ${process.platform} is not supported by pi-generative-ui.`,
      };
    },
    async open() {
      throw new Error(`Unsupported platform: ${process.platform}`);
    },
  };
  return backend;
}

export type {
  BackendSupportError,
  BackendSupportOk,
  OpenWindowOptions,
  WidgetBackend,
  WidgetBackendKind,
  WidgetWindow,
  WidgetWindowEvent,
} from "./types.js";
export { formatSupportError } from "./errors.js";
