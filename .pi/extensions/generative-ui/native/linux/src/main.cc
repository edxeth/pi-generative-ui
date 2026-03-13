#include <dlfcn.h>

#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {
using gboolean = int;
using gint = int;
using gulong = unsigned long;
using gpointer = void*;
using GConnectFlags = unsigned int;
using GCallback = void (*)();

struct _GtkWidget;
struct _GtkWindow;
struct _GtkContainer;
struct _WebKitWebView;
struct _WebKitUserContentManager;
struct _WebKitUserScript;
struct _WebKitJavascriptResult;
struct _JSCValue;

using GtkWidget = _GtkWidget;
using GtkWindow = _GtkWindow;
using GtkContainer = _GtkContainer;
using WebKitWebView = _WebKitWebView;
using WebKitUserContentManager = _WebKitUserContentManager;
using WebKitUserScript = _WebKitUserScript;
using WebKitJavascriptResult = _WebKitJavascriptResult;
using JSCValue = _JSCValue;

constexpr int GTK_WINDOW_TOPLEVEL = 0;
constexpr int WEBKIT_LOAD_FINISHED = 3;
constexpr int WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES = 0;
constexpr int WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START = 0;
constexpr gboolean G_SOURCE_REMOVE = 0;

struct ToolchainSpec {
  const char* name;
  const char* gtkLibrary;
  const char* webkitLibrary;
  const char* javascriptCoreLibrary;
};

struct ToolchainHandle {
  const ToolchainSpec* spec;
  void* gtkHandle;
  void* webkitHandle;
  void* javascriptCoreHandle;
};

using VersionFn = int (*)();

const std::vector<ToolchainSpec> kToolchains = {
    {"gtk4+webkitgtk-6.0", "libgtk-4.so.1", "libwebkitgtk-6.0.so.4", "libjavascriptcoregtk-6.0.so.1"},
    {"gtk3+webkit2gtk-4.1", "libgtk-3.so.0", "libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0"},
};

void close_handle(void* handle) {
  if (handle != nullptr) dlclose(handle);
}

std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)> detect_toolchain() {
  auto deleter = [](ToolchainHandle* handle) {
    if (handle == nullptr) return;
    close_handle(handle->javascriptCoreHandle);
    close_handle(handle->webkitHandle);
    close_handle(handle->gtkHandle);
    delete handle;
  };

  for (const auto& spec : kToolchains) {
    void* gtkHandle = dlopen(spec.gtkLibrary, RTLD_LAZY | RTLD_LOCAL);
    if (gtkHandle == nullptr) continue;

    void* webkitHandle = dlopen(spec.webkitLibrary, RTLD_LAZY | RTLD_LOCAL);
    if (webkitHandle == nullptr) {
      close_handle(gtkHandle);
      continue;
    }

    void* javascriptCoreHandle = dlopen(spec.javascriptCoreLibrary, RTLD_LAZY | RTLD_LOCAL);
    if (javascriptCoreHandle == nullptr) {
      close_handle(webkitHandle);
      close_handle(gtkHandle);
      continue;
    }

    return std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)>(
        new ToolchainHandle{&spec, gtkHandle, webkitHandle, javascriptCoreHandle}, deleter);
  }

  return std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)>(nullptr, deleter);
}

VersionFn require_version_fn(void* library, const char* symbol) {
  dlerror();
  void* resolved = dlsym(library, symbol);
  const char* error = dlerror();
  if (error != nullptr || resolved == nullptr) {
    throw std::runtime_error(std::string("Missing symbol ") + symbol + ": " + (error ? error : "unknown error"));
  }
  return reinterpret_cast<VersionFn>(resolved);
}

int print_version() {
  auto toolchain = detect_toolchain();
  if (!toolchain) {
    std::cerr << "Could not load libgtk-4/libwebkitgtk-6.0 or libgtk-3/libwebkit2gtk-4.1.\n";
    return 1;
  }

  const auto gtkMajor = require_version_fn(toolchain->gtkHandle, "gtk_get_major_version");
  const auto gtkMinor = require_version_fn(toolchain->gtkHandle, "gtk_get_minor_version");
  const auto gtkMicro = require_version_fn(toolchain->gtkHandle, "gtk_get_micro_version");
  const auto webkitMajor = require_version_fn(toolchain->webkitHandle, "webkit_get_major_version");
  const auto webkitMinor = require_version_fn(toolchain->webkitHandle, "webkit_get_minor_version");
  const auto webkitMicro = require_version_fn(toolchain->webkitHandle, "webkit_get_micro_version");

  std::cout << "pi-generative-ui linux helper\n";
  std::cout << "backend=" << toolchain->spec->name << "\n";
  std::cout << "gtk=" << gtkMajor() << "." << gtkMinor() << "." << gtkMicro() << "\n";
  std::cout << "webkit=" << webkitMajor() << "." << webkitMinor() << "." << webkitMicro() << "\n";
  return 0;
}

std::string json_escape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 16);
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
  }
  return out;
}

void append_utf8(std::string& out, unsigned int codepoint) {
  if (codepoint <= 0x7F) {
    out.push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7FF) {
    out.push_back(static_cast<char>(0xC0 | ((codepoint >> 6) & 0x1F)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  } else if (codepoint <= 0xFFFF) {
    out.push_back(static_cast<char>(0xE0 | ((codepoint >> 12) & 0x0F)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | ((codepoint >> 18) & 0x07)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  }
}

class JsonParser {
 public:
  explicit JsonParser(std::string input) : input_(std::move(input)) {}

  std::string parseString() {
    skipWhitespace();
    expect('"');
    std::string value;
    while (index_ < input_.size()) {
      char ch = input_[index_++];
      if (ch == '"') return value;
      if (ch != '\\') {
        value.push_back(ch);
        continue;
      }

      if (index_ >= input_.size()) throw std::runtime_error("Invalid escape sequence");
      char escaped = input_[index_++];
      switch (escaped) {
        case '"': value.push_back('"'); break;
        case '\\': value.push_back('\\'); break;
        case '/': value.push_back('/'); break;
        case 'b': value.push_back('\b'); break;
        case 'f': value.push_back('\f'); break;
        case 'n': value.push_back('\n'); break;
        case 'r': value.push_back('\r'); break;
        case 't': value.push_back('\t'); break;
        case 'u': {
          if (index_ + 4 > input_.size()) throw std::runtime_error("Invalid unicode escape");
          unsigned int codepoint = 0;
          for (int i = 0; i < 4; ++i) {
            char hex = input_[index_++];
            codepoint <<= 4;
            if (hex >= '0' && hex <= '9') codepoint |= static_cast<unsigned int>(hex - '0');
            else if (hex >= 'a' && hex <= 'f') codepoint |= static_cast<unsigned int>(hex - 'a' + 10);
            else if (hex >= 'A' && hex <= 'F') codepoint |= static_cast<unsigned int>(hex - 'A' + 10);
            else throw std::runtime_error("Invalid unicode escape");
          }
          append_utf8(value, codepoint);
          break;
        }
        default:
          throw std::runtime_error("Unsupported escape sequence");
      }
    }
    throw std::runtime_error("Unterminated string literal");
  }

  long parseInteger() {
    skipWhitespace();
    const std::size_t start = index_;
    if (peek() == '-') ++index_;
    while (index_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[index_]))) ++index_;
    if (start == index_) throw std::runtime_error("Expected integer");
    return std::stol(input_.substr(start, index_ - start));
  }

  bool parseBoolean() {
    skipWhitespace();
    if (input_.compare(index_, 4, "true") == 0) {
      index_ += 4;
      return true;
    }
    if (input_.compare(index_, 5, "false") == 0) {
      index_ += 5;
      return false;
    }
    throw std::runtime_error("Expected boolean");
  }

  void skipValue() {
    skipWhitespace();
    const char ch = peek();
    if (ch == '"') {
      (void)parseString();
      return;
    }
    if (ch == '{') {
      expect('{');
      skipWhitespace();
      if (peek() == '}') {
        expect('}');
        return;
      }
      while (true) {
        (void)parseString();
        skipWhitespace();
        expect(':');
        skipValue();
        skipWhitespace();
        if (peek() == ',') {
          expect(',');
          continue;
        }
        expect('}');
        return;
      }
    }
    if (ch == '[') {
      expect('[');
      skipWhitespace();
      if (peek() == ']') {
        expect(']');
        return;
      }
      while (true) {
        skipValue();
        skipWhitespace();
        if (peek() == ',') {
          expect(',');
          continue;
        }
        expect(']');
        return;
      }
    }
    if (std::isdigit(static_cast<unsigned char>(ch)) || ch == '-') {
      (void)parseInteger();
      return;
    }
    if (ch == 't' || ch == 'f') {
      (void)parseBoolean();
      return;
    }
    if (input_.compare(index_, 4, "null") == 0) {
      index_ += 4;
      return;
    }
    throw std::runtime_error("Unsupported JSON value");
  }

  void skipWhitespace() {
    while (index_ < input_.size() && std::isspace(static_cast<unsigned char>(input_[index_]))) ++index_;
  }

  void expect(char ch) {
    skipWhitespace();
    if (index_ >= input_.size() || input_[index_] != ch) {
      throw std::runtime_error(std::string("Expected '") + ch + "'");
    }
    ++index_;
  }

  char peek() {
    skipWhitespace();
    if (index_ >= input_.size()) throw std::runtime_error("Unexpected end of JSON input");
    return input_[index_];
  }

  bool hasMore() {
    skipWhitespace();
    return index_ < input_.size();
  }

 private:
  std::string input_;
  std::size_t index_ = 0;
};

struct HostCommand {
  std::string type;
  std::string html;
  std::string js;
  std::string title = "Widget";
  int width = 800;
  int height = 600;
  bool floating = false;
};

HostCommand parse_command(const std::string& line) {
  JsonParser parser(line);
  HostCommand command;

  parser.expect('{');
  if (parser.peek() == '}') {
    parser.expect('}');
    return command;
  }

  while (true) {
    const std::string key = parser.parseString();
    parser.expect(':');

    if (key == "type") command.type = parser.parseString();
    else if (key == "html") command.html = parser.parseString();
    else if (key == "js") command.js = parser.parseString();
    else if (key == "title") command.title = parser.parseString();
    else if (key == "width") command.width = static_cast<int>(parser.parseInteger());
    else if (key == "height") command.height = static_cast<int>(parser.parseInteger());
    else if (key == "floating") command.floating = parser.parseBoolean();
    else parser.skipValue();

    if (!parser.hasMore()) break;
    if (parser.peek() == ',') {
      parser.expect(',');
      continue;
    }
    if (parser.peek() == '}') {
      parser.expect('}');
      break;
    }
  }

  return command;
}

using GtkInitCheckFn = gboolean (*)(int*, char***);
using GtkMainFn = void (*)();
using GtkMainQuitFn = void (*)();
using GtkWindowNewFn = GtkWidget* (*)(int);
using GtkWindowSetTitleFn = void (*)(GtkWindow*, const char*);
using GtkWindowSetDefaultSizeFn = void (*)(GtkWindow*, gint, gint);
using GtkContainerAddFn = void (*)(GtkContainer*, GtkWidget*);
using GtkWidgetShowAllFn = void (*)(GtkWidget*);
using GtkWidgetDestroyFn = void (*)(GtkWidget*);
using GtkWindowPresentFn = void (*)(GtkWindow*);

using GSignalConnectDataFn = gulong (*)(gpointer, const char*, GCallback, gpointer, gpointer, GConnectFlags);
using GObjectUnrefFn = void (*)(gpointer);
using GIdleAddFn = unsigned int (*)(gboolean (*)(gpointer), gpointer);
using GFreeFn = void (*)(gpointer);

using WebKitUserContentManagerNewFn = WebKitUserContentManager* (*)();
using WebKitUserContentManagerRegisterScriptMessageHandlerFn = gboolean (*)(WebKitUserContentManager*, const char*);
using WebKitUserContentManagerAddScriptFn = void (*)(WebKitUserContentManager*, WebKitUserScript*);
using WebKitUserScriptNewFn = WebKitUserScript* (*)(const char*, int, int, const char* const*, const char* const*);
using WebKitWebViewNewWithUserContentManagerFn = GtkWidget* (*)(WebKitUserContentManager*);
using WebKitWebViewLoadHtmlFn = void (*)(WebKitWebView*, const char*, const char*);
using WebKitWebViewRunJavascriptFn = void (*)(WebKitWebView*, const char*, gpointer, gpointer, gpointer);
using WebKitJavascriptResultGetJsValueFn = JSCValue* (*)(WebKitJavascriptResult*);
using JscValueToStringFn = char* (*)(JSCValue*);

struct RuntimeApi {
  RuntimeApi() = default;
  RuntimeApi(const RuntimeApi&) = delete;
  RuntimeApi& operator=(const RuntimeApi&) = delete;
  RuntimeApi(RuntimeApi&&) noexcept = default;
  RuntimeApi& operator=(RuntimeApi&&) noexcept = default;

  std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)> toolchain{nullptr, [](ToolchainHandle*) {}};
  void* glibHandle = nullptr;
  void* gobjectHandle = nullptr;

  GtkInitCheckFn gtk_init_check = nullptr;
  GtkMainFn gtk_main = nullptr;
  GtkMainQuitFn gtk_main_quit = nullptr;
  GtkWindowNewFn gtk_window_new = nullptr;
  GtkWindowSetTitleFn gtk_window_set_title = nullptr;
  GtkWindowSetDefaultSizeFn gtk_window_set_default_size = nullptr;
  GtkContainerAddFn gtk_container_add = nullptr;
  GtkWidgetShowAllFn gtk_widget_show_all = nullptr;
  GtkWidgetDestroyFn gtk_widget_destroy = nullptr;
  GtkWindowPresentFn gtk_window_present = nullptr;

  GSignalConnectDataFn g_signal_connect_data = nullptr;
  GObjectUnrefFn g_object_unref = nullptr;
  GIdleAddFn g_idle_add = nullptr;
  GFreeFn g_free = nullptr;

  WebKitUserContentManagerNewFn webkit_user_content_manager_new = nullptr;
  WebKitUserContentManagerRegisterScriptMessageHandlerFn webkit_user_content_manager_register_script_message_handler = nullptr;
  WebKitUserContentManagerAddScriptFn webkit_user_content_manager_add_script = nullptr;
  WebKitUserScriptNewFn webkit_user_script_new = nullptr;
  WebKitWebViewNewWithUserContentManagerFn webkit_web_view_new_with_user_content_manager = nullptr;
  WebKitWebViewLoadHtmlFn webkit_web_view_load_html = nullptr;
  WebKitWebViewRunJavascriptFn webkit_web_view_run_javascript = nullptr;
  WebKitJavascriptResultGetJsValueFn webkit_javascript_result_get_js_value = nullptr;
  JscValueToStringFn jsc_value_to_string = nullptr;

  ~RuntimeApi() {
    close_handle(gobjectHandle);
    close_handle(glibHandle);
  }
};

template <typename T>
T require_symbol(void* handle, const char* symbol) {
  dlerror();
  void* resolved = dlsym(handle, symbol);
  const char* error = dlerror();
  if (error != nullptr || resolved == nullptr) {
    throw std::runtime_error(std::string("Missing symbol ") + symbol + ": " + (error ? error : "unknown error"));
  }
  return reinterpret_cast<T>(resolved);
}

RuntimeApi load_runtime(bool require_window_runtime) {
  RuntimeApi runtime;
  runtime.toolchain = detect_toolchain();
  if (!runtime.toolchain) {
    throw std::runtime_error("Could not load a supported GTK/WebKitGTK runtime pair.");
  }

  if (require_window_runtime && std::string(runtime.toolchain->spec->name) != "gtk3+webkit2gtk-4.1") {
    throw std::runtime_error("Window protocol currently requires the gtk3+webkit2gtk-4.1 runtime.");
  }

  runtime.glibHandle = dlopen("libglib-2.0.so.0", RTLD_LAZY | RTLD_LOCAL);
  runtime.gobjectHandle = dlopen("libgobject-2.0.so.0", RTLD_LAZY | RTLD_LOCAL);
  if (runtime.glibHandle == nullptr || runtime.gobjectHandle == nullptr) {
    throw std::runtime_error("Could not load libglib-2.0.so.0 or libgobject-2.0.so.0.");
  }

  runtime.gtk_init_check = require_symbol<GtkInitCheckFn>(runtime.toolchain->gtkHandle, "gtk_init_check");
  runtime.gtk_main = require_symbol<GtkMainFn>(runtime.toolchain->gtkHandle, "gtk_main");
  runtime.gtk_main_quit = require_symbol<GtkMainQuitFn>(runtime.toolchain->gtkHandle, "gtk_main_quit");
  runtime.gtk_window_new = require_symbol<GtkWindowNewFn>(runtime.toolchain->gtkHandle, "gtk_window_new");
  runtime.gtk_window_set_title = require_symbol<GtkWindowSetTitleFn>(runtime.toolchain->gtkHandle, "gtk_window_set_title");
  runtime.gtk_window_set_default_size = require_symbol<GtkWindowSetDefaultSizeFn>(runtime.toolchain->gtkHandle, "gtk_window_set_default_size");
  runtime.gtk_container_add = require_symbol<GtkContainerAddFn>(runtime.toolchain->gtkHandle, "gtk_container_add");
  runtime.gtk_widget_show_all = require_symbol<GtkWidgetShowAllFn>(runtime.toolchain->gtkHandle, "gtk_widget_show_all");
  runtime.gtk_widget_destroy = require_symbol<GtkWidgetDestroyFn>(runtime.toolchain->gtkHandle, "gtk_widget_destroy");
  runtime.gtk_window_present = require_symbol<GtkWindowPresentFn>(runtime.toolchain->gtkHandle, "gtk_window_present");

  runtime.g_signal_connect_data = require_symbol<GSignalConnectDataFn>(runtime.gobjectHandle, "g_signal_connect_data");
  runtime.g_object_unref = require_symbol<GObjectUnrefFn>(runtime.gobjectHandle, "g_object_unref");
  runtime.g_idle_add = require_symbol<GIdleAddFn>(runtime.glibHandle, "g_idle_add");
  runtime.g_free = require_symbol<GFreeFn>(runtime.glibHandle, "g_free");

  runtime.webkit_user_content_manager_new = require_symbol<WebKitUserContentManagerNewFn>(runtime.toolchain->webkitHandle, "webkit_user_content_manager_new");
  runtime.webkit_user_content_manager_register_script_message_handler =
      require_symbol<WebKitUserContentManagerRegisterScriptMessageHandlerFn>(runtime.toolchain->webkitHandle,
                                                                            "webkit_user_content_manager_register_script_message_handler");
  runtime.webkit_user_content_manager_add_script =
      require_symbol<WebKitUserContentManagerAddScriptFn>(runtime.toolchain->webkitHandle, "webkit_user_content_manager_add_script");
  runtime.webkit_user_script_new = require_symbol<WebKitUserScriptNewFn>(runtime.toolchain->webkitHandle, "webkit_user_script_new");
  runtime.webkit_web_view_new_with_user_content_manager =
      require_symbol<WebKitWebViewNewWithUserContentManagerFn>(runtime.toolchain->webkitHandle,
                                                               "webkit_web_view_new_with_user_content_manager");
  runtime.webkit_web_view_load_html =
      require_symbol<WebKitWebViewLoadHtmlFn>(runtime.toolchain->webkitHandle, "webkit_web_view_load_html");
  runtime.webkit_web_view_run_javascript =
      require_symbol<WebKitWebViewRunJavascriptFn>(runtime.toolchain->webkitHandle, "webkit_web_view_run_javascript");
  runtime.webkit_javascript_result_get_js_value =
      require_symbol<WebKitJavascriptResultGetJsValueFn>(runtime.toolchain->webkitHandle,
                                                         "webkit_javascript_result_get_js_value");
  runtime.jsc_value_to_string =
      require_symbol<JscValueToStringFn>(runtime.toolchain->javascriptCoreHandle, "jsc_value_to_string");

  return runtime;
}

bool init_gtk(RuntimeApi& runtime) {
  return runtime.gtk_init_check(nullptr, nullptr) != 0;
}

struct AppState;
extern "C" gboolean handle_eval_idle(gpointer data);
extern "C" gboolean handle_close_idle(gpointer data);
extern "C" void on_window_destroy(GtkWidget* widget, gpointer data);
extern "C" void on_load_changed(WebKitWebView* webview, gint load_event, gpointer data);
extern "C" void on_script_message_received(WebKitUserContentManager* manager, WebKitJavascriptResult* result, gpointer data);

struct PendingEval {
  AppState* app;
  std::string js;
};

struct AppState {
  RuntimeApi runtime;
  GtkWidget* window = nullptr;
  WebKitWebView* webview = nullptr;
  WebKitUserContentManager* contentManager = nullptr;
  std::mutex stdoutMutex;
  std::atomic<bool> readySent{false};
  std::atomic<bool> closed{false};

  void emit_line(const std::string& line) {
    std::lock_guard<std::mutex> lock(stdoutMutex);
    std::cout << line << std::endl;
  }

  void emit_ready() {
    if (readySent.exchange(true)) return;
    emit_line("{\"type\":\"ready\"}");
  }

  void emit_message_json(const std::string& json) {
    emit_line(std::string("{\"type\":\"message\",\"data\":") + json + "}");
  }

  void emit_closed() {
    const bool wasClosed = closed.exchange(true);
    if (!wasClosed) emit_line("{\"type\":\"closed\"}");
    runtime.gtk_main_quit();
  }

  void emit_error(const std::string& code, const std::string& message) {
    emit_line("{\"type\":\"error\",\"code\":\"" + json_escape(code) + "\",\"message\":\"" +
              json_escape(message) + "\"}");
  }

  void schedule_eval(std::string js) {
    auto* pending = new PendingEval{this, std::move(js)};
    runtime.g_idle_add(handle_eval_idle, pending);
  }

  void schedule_close() { runtime.g_idle_add(handle_close_idle, this); }
};

extern "C" gboolean handle_eval_idle(gpointer data) {
  auto* pending = static_cast<PendingEval*>(data);
  if (pending->app->webview != nullptr && !pending->app->closed.load()) {
    pending->app->runtime.webkit_web_view_run_javascript(pending->app->webview, pending->js.c_str(), nullptr, nullptr,
                                                         nullptr);
  }
  delete pending;
  return G_SOURCE_REMOVE;
}

extern "C" gboolean handle_close_idle(gpointer data) {
  auto* app = static_cast<AppState*>(data);
  if (app->closed.load()) return G_SOURCE_REMOVE;
  if (app->window != nullptr) app->runtime.gtk_widget_destroy(app->window);
  return G_SOURCE_REMOVE;
}

extern "C" void on_window_destroy(GtkWidget* /*widget*/, gpointer data) {
  static_cast<AppState*>(data)->emit_closed();
}

extern "C" void on_load_changed(WebKitWebView* /*webview*/, gint load_event, gpointer data) {
  if (load_event == WEBKIT_LOAD_FINISHED) static_cast<AppState*>(data)->emit_ready();
}

extern "C" void on_script_message_received(WebKitUserContentManager* /*manager*/, WebKitJavascriptResult* result,
                                             gpointer data) {
  auto* app = static_cast<AppState*>(data);
  JSCValue* jsValue = app->runtime.webkit_javascript_result_get_js_value(result);
  char* raw = app->runtime.jsc_value_to_string(jsValue);
  if (raw == nullptr) return;

  std::string payload(raw);
  app->runtime.g_free(raw);

  constexpr const char* kMessagePrefix = "__GLIMPSE_MSG__:";
  constexpr const char* kCloseMessage = "__GLIMPSE_CLOSE__";

  if (payload == kCloseMessage) {
    app->schedule_close();
    return;
  }

  if (payload.rfind(kMessagePrefix, 0) == 0) {
    app->emit_message_json(payload.substr(std::char_traits<char>::length(kMessagePrefix)));
    return;
  }

  app->emit_error("BACKEND_START_FAILED", "Received an unknown message from the widget bridge.");
}

std::string bridge_script() {
  return R"JS(
(function () {
  const bridge = {
    send(data) {
      window.webkit.messageHandlers.glimpse.postMessage("__GLIMPSE_MSG__:" + JSON.stringify(data));
    },
    close() {
      window.webkit.messageHandlers.glimpse.postMessage("__GLIMPSE_CLOSE__");
    }
  };
  Object.defineProperty(window, "glimpse", {
    value: bridge,
    configurable: true,
    enumerable: false,
    writable: false,
  });
})();
)JS";
}

std::unique_ptr<AppState> create_app(const HostCommand& command) {
  auto app = std::make_unique<AppState>();
  app->runtime = load_runtime(true);
  if (!init_gtk(app->runtime)) {
    throw std::runtime_error("GTK could not initialize a GUI display. Verify DISPLAY/WSLg is available.");
  }

  app->contentManager = app->runtime.webkit_user_content_manager_new();
  if (app->contentManager == nullptr) throw std::runtime_error("Failed to create WebKit user content manager.");

  if (app->runtime.webkit_user_content_manager_register_script_message_handler(app->contentManager, "glimpse") == 0) {
    throw std::runtime_error("Failed to register the glimpse script message handler.");
  }

  WebKitUserScript* script = app->runtime.webkit_user_script_new(
      bridge_script().c_str(), WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
      nullptr, nullptr);
  if (script == nullptr) throw std::runtime_error("Failed to create the injected glimpse bridge script.");
  app->runtime.webkit_user_content_manager_add_script(app->contentManager, script);
  app->runtime.g_object_unref(script);

  app->window = app->runtime.gtk_window_new(GTK_WINDOW_TOPLEVEL);
  if (app->window == nullptr) throw std::runtime_error("Failed to create the GTK window.");

  app->runtime.gtk_window_set_title(reinterpret_cast<GtkWindow*>(app->window), command.title.c_str());
  app->runtime.gtk_window_set_default_size(reinterpret_cast<GtkWindow*>(app->window), command.width, command.height);

  GtkWidget* webviewWidget = app->runtime.webkit_web_view_new_with_user_content_manager(app->contentManager);
  if (webviewWidget == nullptr) throw std::runtime_error("Failed to create the WebKit webview.");
  app->webview = reinterpret_cast<WebKitWebView*>(webviewWidget);

  app->runtime.g_signal_connect_data(app->window, "destroy", reinterpret_cast<GCallback>(on_window_destroy), app.get(),
                                     nullptr, 0);
  app->runtime.g_signal_connect_data(app->webview, "load-changed", reinterpret_cast<GCallback>(on_load_changed), app.get(),
                                     nullptr, 0);
  app->runtime.g_signal_connect_data(app->contentManager, "script-message-received::glimpse",
                                     reinterpret_cast<GCallback>(on_script_message_received), app.get(), nullptr, 0);

  app->runtime.gtk_container_add(reinterpret_cast<GtkContainer*>(app->window), webviewWidget);
  app->runtime.gtk_widget_show_all(app->window);
  app->runtime.gtk_window_present(reinterpret_cast<GtkWindow*>(app->window));
  app->runtime.webkit_web_view_load_html(app->webview, command.html.c_str(), nullptr);
  return app;
}

void reader_loop(AppState* app) {
  try {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.empty()) continue;
      HostCommand command = parse_command(line);
      if (command.type == "eval") {
        app->schedule_eval(command.js);
      } else if (command.type == "close") {
        app->schedule_close();
        return;
      }
    }
  } catch (const std::exception& error) {
    app->emit_error("BACKEND_START_FAILED", error.what());
    app->schedule_close();
  }
}

int probe_open_runtime() {
  try {
    RuntimeApi runtime = load_runtime(true);
    if (!init_gtk(runtime)) {
      std::cerr << "GTK could not initialize a GUI display. Verify DISPLAY/WSLg is available.\n";
      return 2;
    }
    std::cout << "probe=ok\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 1) {
    const std::string arg = argv[1];
    if (arg == "--version" || arg == "--self-test") {
      try {
        return print_version();
      } catch (const std::exception& error) {
        std::cerr << error.what() << "\n";
        return 1;
      }
    }
    if (arg == "--probe-open") {
      return probe_open_runtime();
    }
  }

  try {
    std::string firstLine;
    if (!std::getline(std::cin, firstLine)) {
      std::cerr << "Expected an initial html command on stdin.\n";
      return 64;
    }

    HostCommand initial = parse_command(firstLine);
    if (initial.type != "html") {
      std::cerr << "The first helper command must be type=html.\n";
      return 64;
    }

    auto app = create_app(initial);
    std::thread reader(reader_loop, app.get());
    reader.detach();
    app->runtime.gtk_main();
    return 0;
  } catch (const std::exception& error) {
    std::cout << "{\"type\":\"error\",\"code\":\"BACKEND_START_FAILED\",\"message\":\""
              << json_escape(error.what()) << "\"}" << std::endl;
    return 1;
  }
}
