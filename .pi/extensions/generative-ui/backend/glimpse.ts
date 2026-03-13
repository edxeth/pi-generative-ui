import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WidgetBackend } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLIMPSE_PATH = join(__dirname, "../../../../node_modules/glimpseui/src/glimpse.mjs");

let glimpseModule: { open: (html: string, options: Record<string, unknown>) => any } | null = null;

async function getGlimpse() {
  if (!glimpseModule) glimpseModule = await import(GLIMPSE_PATH);
  return glimpseModule;
}

export class GlimpseBackend implements WidgetBackend {
  kind = "glimpse" as const;

  async checkSupport() {
    if (process.platform !== "darwin") {
      return {
        ok: false as const,
        code: "UNSUPPORTED_PLATFORM" as const,
        reason: `Platform ${process.platform} is not supported by the macOS Glimpse backend.`,
      };
    }

    try {
      await getGlimpse();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        code: "BACKEND_START_FAILED" as const,
        reason: error instanceof Error ? error.message : String(error),
        fixes: ["Run npm install so the optional glimpseui dependency is available on macOS."],
      };
    }
  }

  async open(html: string, options: { width: number; height: number; title: string; floating?: boolean }) {
    const { open } = await getGlimpse();
    return open(html, options);
  }
}
