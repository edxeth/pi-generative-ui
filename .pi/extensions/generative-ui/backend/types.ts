export type WidgetBackendKind = "glimpse" | "linux-webview";
export type WidgetWindowEvent = "ready" | "message" | "closed" | "error";

export interface OpenWindowOptions {
  title: string;
  width: number;
  height: number;
  floating?: boolean;
}

export interface BackendSupportOk {
  ok: true;
}

export interface BackendSupportError {
  ok: false;
  code:
    | "UNSUPPORTED_PLATFORM"
    | "NO_GUI_DISPLAY"
    | "WSLG_REQUIRED"
    | "BACKEND_BINARY_MISSING"
    | "BACKEND_BINARY_NOT_EXECUTABLE"
    | "WEBKIT_RUNTIME_MISSING"
    | "BACKEND_START_FAILED";
  reason: string;
  fixes?: string[];
}

export interface WidgetWindow {
  on(event: WidgetWindowEvent, handler: (...args: unknown[]) => void): void;
  send(js: string): void;
  close(): void;
}

export interface WidgetBackend {
  kind: WidgetBackendKind;
  checkSupport(): Promise<BackendSupportOk | BackendSupportError>;
  open(html: string, options: OpenWindowOptions): Promise<WidgetWindow>;
}
