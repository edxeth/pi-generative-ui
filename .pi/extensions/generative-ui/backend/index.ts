import type { WidgetBackend } from "./types.js";
import { GlimpseBackend } from "./glimpse.js";
import { LinuxWebviewBackend } from "./linux.js";

let backend: WidgetBackend | null = null;

function getRuntimePlatform() {
  return process.env.PI_GENERATIVE_UI_TEST_PLATFORM || process.platform;
}

export function getWidgetBackend(): WidgetBackend {
  if (backend) return backend;

  const platform = getRuntimePlatform();

  if (platform === "darwin") {
    backend = new GlimpseBackend();
    return backend;
  }

  if (platform === "linux") {
    backend = new LinuxWebviewBackend();
    return backend;
  }

  backend = {
    kind: "linux-webview",
    async checkSupport() {
      return {
        ok: false as const,
        code: "UNSUPPORTED_PLATFORM" as const,
        reason: `Platform ${platform} is not supported by pi-generative-ui.`,
      };
    },
    async open() {
      throw new Error(`Unsupported platform: ${platform}`);
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
