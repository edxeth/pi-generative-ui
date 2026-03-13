## 2026-03-13 - Item 1: Linux install/build path
- Item worked on: Linux package installation succeeds without `EBADPLATFORM` and produces an executable helper binary.
- Key decisions: moved `glimpseui` to `optionalDependencies`; removed the darwin-only package gate; added a Linux `postinstall` build that compiles a repo-local helper and self-tests detected GTK/WebKitGTK runtime pairs before succeeding.
- Files changed: `package.json`, `scripts/postinstall.js`, `.pi/extensions/generative-ui/native/linux/src/main.cc`, `package-lock.json`.
- Verification: `npm install` ✅ (clean no-`node_modules` run, postinstall built helper, no `EBADPLATFORM` in output); `npm pack --dry-run` ✅; `ls -l .pi/extensions/generative-ui/native/linux/bin` ✅; `.pi/extensions/generative-ui/native/linux/bin/pi-generative-ui-linux-helper --version` ✅ (`gtk3+webkit2gtk-4.1`).
- Next iteration notes: implement backend abstraction + Linux helper window protocol so headed interactive `pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui` can open a native widget and round-trip `window.glimpse.send(...)`.

## 2026-03-13 - Item 6: package metadata + docs
- Item worked on: Package metadata and documentation for Linux/WSLg support and validation workflow.
- Key decisions: added a `files` whitelist so published tarballs only include runtime assets; updated README to document `pi install`, WSLg prerequisites, and the headed local verification command while noting the current environment still hangs on GUI/display probes for widget-runtime verification.
- Files changed: `package.json`, `README.md`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅ (postinstall rebuilt the Linux helper); `npm pack --dry-run` ✅ (tarball reduced to package runtime files only); `grep 'pi install|WSLg|pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui' README.md` ✅; `ls -l .pi/extensions/generative-ui/native/linux/bin` ✅.
- Next iteration notes: continue item 2 or item 5 from the new backend groundwork, but first resolve why GUI/display probes (`xwininfo`, helper `--probe-open`) hang in this WSL environment before attempting headed widget verification again.

## 2026-03-13 - Item 5: Linux diagnostics
- Item worked on: Linux diagnostics clearly distinguish missing display, missing helper binary, and missing runtime prerequisites.
- Key decisions: replaced the blocking `spawnSync --probe-open` check with a bounded async probe that returns actionable WSLg/display guidance instead of hanging, and added `PI_GENERATIVE_UI_LINUX_HELPER_PATH` so diagnostics can exercise missing/non-executable/runtime-failure helper scenarios without editing package assets.
- Files changed: `.pi/extensions/generative-ui/backend/linux.ts`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; `npx --yes tsx -e "import { LinuxWebviewBackend } from './.pi/extensions/generative-ui/backend/linux.ts'; const backend = new LinuxWebviewBackend(); backend.checkSupport().then((result) => console.log(JSON.stringify(result, null, 2)));"` ✅ (`WSLG_REQUIRED` on the current stale WSL display bridge instead of hanging); `env -u DISPLAY -u WAYLAND_DISPLAY ...checkSupport()` ✅ (`WSLG_REQUIRED` for missing display); `PI_GENERATIVE_UI_LINUX_HELPER_PATH=/tmp/does-not-exist-helper ...checkSupport()` ✅ (`BACKEND_BINARY_MISSING`); temp copied helper with execute bit removed ✅ (`BACKEND_BINARY_NOT_EXECUTABLE`); temp stub helper emitting missing `libwebkit2gtk-4.1.so.0` ✅ (`WEBKIT_RUNTIME_MISSING` with remediation guidance).
- Next iteration notes: return to item 2 once a live WSLg display bridge is available, because the current environment still reports `WSLG_REQUIRED` even with `DISPLAY=172.17.128.1:0.0` set.

## 2026-03-13 - Item 2: headed interactive widget roundtrip visibility
- Item worked on: Headed interactive `pi` session feedback for the Linux widget/message roundtrip item.
- Key decisions: kept item 2 failing because the current WSL session still has a stale display bridge, but updated `show_widget`'s custom TUI renderer so interactive `pi` now shows backend failures inline and will surface returned `messageData` without requiring tool expansion when a widget round-trip succeeds.
- Files changed: `.pi/extensions/generative-ui/index.ts`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; headed `interactive_shell` run of `pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui "Use visualize_read_me ... show_widget ... window.glimpse.send(...)"` ✅ for renderer behavior (pi now shows `✗ Widget error` with `Backend: linux-webview`, `Code: WSLG_REQUIRED`, and fixes inline) but ❌ for item completion because no native widget window opened and no payload returned.
- Next iteration notes: restore a live WSLg display bridge (current `DISPLAY=172.17.128.1:0.0` is stale) and then re-run the headed interactive acceptance prompt to verify the real window opens and `window.glimpse.send(...)` returns data in pi.
