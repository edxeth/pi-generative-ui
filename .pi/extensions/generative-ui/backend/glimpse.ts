import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WidgetBackend } from "./types.js";

const requireFromHere = createRequire(import.meta.url);

let glimpseModule: { open: (html: string, options: Record<string, unknown>) => any } | null = null;

function getRuntimePlatform() {
  return process.env.PI_GENERATIVE_UI_TEST_PLATFORM || process.platform;
}

function isMissingGlimpseDependency(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot find module") && message.includes("glimpseui");
}

function resolveGlimpsePath(): string {
  const override = process.env.PI_GENERATIVE_UI_GLIMPSE_MODULE;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return requireFromHere.resolve("glimpseui/src/glimpse.mjs");
}

async function getGlimpse() {
  if (!glimpseModule) {
    const glimpsePath = resolveGlimpsePath();
    glimpseModule = await import(pathToFileURL(glimpsePath).href);
  }
  return glimpseModule;
}

export class GlimpseBackend implements WidgetBackend {
  kind = "glimpse" as const;

  async checkSupport() {
    const platform = getRuntimePlatform();
    if (platform !== "darwin") {
      return {
        ok: false as const,
        code: "UNSUPPORTED_PLATFORM" as const,
        reason: `Platform ${platform} is not supported by the macOS Glimpse backend.`,
      };
    }

    try {
      await getGlimpse();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        code: "BACKEND_START_FAILED" as const,
        reason: isMissingGlimpseDependency(error)
          ? "The optional macOS dependency 'glimpseui' is not installed or could not be resolved from this package."
          : (error instanceof Error ? error.message : String(error)),
        fixes: [
          "Run npm install on macOS so the optional glimpseui dependency is available.",
          "If you installed from a packed tarball, confirm node_modules/glimpseui is present for this package.",
        ],
      };
    }
  }

  async open(html: string, options: { width: number; height: number; title: string; floating?: boolean }) {
    const { open } = await getGlimpse();
    return open(html, options);
  }
}
