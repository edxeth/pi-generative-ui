import type { BackendSupportError, WidgetBackendKind } from "./types.js";

export function formatSupportError(kind: WidgetBackendKind, error: BackendSupportError): string {
  const lines = [
    `Backend: ${kind}`,
    `Code: ${error.code}`,
    `Cause: ${error.reason}`,
  ];

  if (error.fixes?.length) {
    lines.push("Fixes:");
    for (const fix of error.fixes) lines.push(`- ${fix}`);
  }

  return lines.join("\n");
}
