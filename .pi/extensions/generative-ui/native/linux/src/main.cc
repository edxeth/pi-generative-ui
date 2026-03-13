#include <dlfcn.h>

#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace {
struct ToolchainSpec {
  const char* name;
  const char* gtkLibrary;
  const char* webkitLibrary;
};

struct ToolchainHandle {
  const ToolchainSpec* spec;
  void* gtkHandle;
  void* webkitHandle;
};

using VersionFn = int (*)();

const std::vector<ToolchainSpec> kToolchains = {
    {"gtk4+webkitgtk-6.0", "libgtk-4.so.1", "libwebkitgtk-6.0.so.4"},
    {"gtk3+webkit2gtk-4.1", "libgtk-3.so.0", "libwebkit2gtk-4.1.so.0"},
};

void close_handle(void* handle) {
  if (handle != nullptr) {
    dlclose(handle);
  }
}

std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)> detect_toolchain() {
  auto deleter = [](ToolchainHandle* handle) {
    if (handle == nullptr) return;
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

    return std::unique_ptr<ToolchainHandle, void (*)(ToolchainHandle*)>(
        new ToolchainHandle{&spec, gtkHandle, webkitHandle}, deleter);
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
  }

  std::cerr << "pi-generative-ui linux helper is installed, but runtime window protocol support is not implemented in this iteration.\n";
  std::cerr << "Run with --version to confirm the detected GTK/WebKitGTK backend.\n";
  return 64;
}
