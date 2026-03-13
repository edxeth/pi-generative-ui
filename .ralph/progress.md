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

## 2026-03-13 - Item 2: headed interactive widget roundtrip acceptance
- Item worked on: A headed interactive pi session can open a native Linux widget window and receive a `window.glimpse.send(...)` payload.
- Key decisions: used a live Xvfb display on `:99` for this WSL session because the ambient WSLg `DISPLAY` remained stale; no implementation changes were needed once a working headed Linux display was available.
- Files changed: `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; `Xvfb :99 -screen 0 1280x720x24` ✅; headed `interactive_shell` run of `env DISPLAY=:99 pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui "...window.glimpse.send(...)..."` ✅; `DISPLAY=:99 xwininfo -root -tree` ✅ (showed native `linux roundtrip` GTK/WebKit window while pi stayed interactive); interactive pi tool result ✅ (`Data: {"ok":true,"source":"xvfb-headed-pi","backend":"linux-webview"}`).
- Next iteration notes: move to item 3 and verify streamed partial updates on the same live display path before touching lifecycle or macOS regression work.

## 2026-03-13 - Item 3: streamed widget finalization
- Item worked on: Streamed widget rendering updates appear incrementally in the headed pi session and finalize by executing deferred scripts once.
- Key decisions: fixed the streamed-window state machine to track final HTML separately from partial HTML, execute deferred scripts only once, and reuse an in-flight streamed window from `show_widget.execute()` instead of re-sending the final payload.
- Files changed: `.pi/extensions/generative-ui/index.ts`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; `Xvfb :101 -screen 0 1280x720x24` ✅; headed `interactive_shell` run of `env DISPLAY=:101 pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui "Use visualize_read_me ... show_widget ..."` ✅; first status check at 34s showed `show_widget stream probe 860×760` while pi was still working ✅; `DISPLAY=:101 xwininfo -root -tree` ✅ (native `stream probe` window visible before completion); `DISPLAY=:101 import ...` + `compare -metric AE` ✅ (`diff12=877`, `diff23=0`, confirming an intermediate visible DOM update before the final stable render); final interactive pi output after kill ✅ (`Data: {"scriptRuns":1,"finalStatus":"finalized","rowCount":48}`).
- Next iteration notes: move to item 4 and verify manual-close plus abort semantics, including orphan-helper cleanup, on the same Xvfb-headed Linux path before attempting macOS regression work.

## 2026-03-13 - Item 4: lifecycle close + abort cleanup
- Item worked on: Widget lifecycle resolution on Linux preserves manual close and abort behavior.
- Key decisions: taught the streaming state machine to abandon and close any in-flight window when an assistant message ends with `stopReason: "aborted"`, and guarded delayed/opening callbacks so aborted streamed windows cannot survive until timeout.
- Files changed: `.pi/extensions/generative-ui/index.ts`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; headed `interactive_shell` run of `env DISPLAY=:103 pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui "...manual_close_verify..."` ✅; `DISPLAY=:103 xwininfo -root -tree` before/after `xkill` ✅ (native `manual close verify` window disappeared); `pgrep -af pi-generative-ui-linux-helper` after manual close ✅ (no helper left); headed Linux `pi --mode rpc` abort harness on DISPLAY=:103 ✅ (`tool_execution_start` observed, abort sent, tool result details reported `closedReason:"Aborted."`, native `rpc abort verify` window gone, no orphan helper).
- Next iteration notes: only the macOS regression item remains failing; complete it in a real macOS environment instead of guessing from Linux.

## 2026-03-13 - Item 7: macOS regression harness prep
- Item worked on: The macOS Glimpse backend path remains intact and is ready for regression verification in a real macOS environment.
- Key decisions: added a deterministic `pi --mode rpc` harness that exercises the Glimpse message roundtrip and close semantics on macOS, but kept the item failing because this WSL2/Linux environment cannot perform the required real-macOS run.
- Files changed: `scripts/verify-macos-glimpse.js`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `node --check scripts/verify-macos-glimpse.js` ✅; `npm install` ✅; `npm pack --dry-run` ✅; `node scripts/verify-macos-glimpse.js` ❌ as expected on Linux (`must be run in a real macOS environment`).
- Next iteration notes: run `node scripts/verify-macos-glimpse.js` on macOS with pi and model credentials configured, confirm the headed Glimpse windows visibly open during both scenarios, then update item 7 only if the real macOS run passes.

## 2026-03-13 - Item 7: macOS regression harness hardening
- Item worked on: The macOS Glimpse backend path remains intact and regression verification is more deterministic, but still unverified on a real macOS host.
- Key decisions: replaced the hard-coded Glimpse module path with lazy package resolution, and upgraded the macOS harness to wait for a titled native window, verify an exact roundtrip payload, and close the manual-close scenario through macOS System Events instead of page script shortcuts.
- Files changed: `.pi/extensions/generative-ui/backend/glimpse.ts`, `scripts/verify-macos-glimpse.js`, `.ralph/items.json`, `.ralph/progress.md`.
- Verification: `npm install` ✅; `npm pack --dry-run` ✅; `node --check scripts/verify-macos-glimpse.js` ✅; `npx --yes tsx -e "import { GlimpseBackend } from './.pi/extensions/generative-ui/backend/glimpse.ts'; const backend = new GlimpseBackend(); backend.checkSupport().then((result) => console.log(JSON.stringify(result, null, 2)));"` ✅ (`UNSUPPORTED_PLATFORM` on Linux without crashing on optional Glimpse resolution); `node scripts/verify-macos-glimpse.js` ❌ as expected on Linux (`must be run in a real macOS environment`).
- Next iteration notes: run `node scripts/verify-macos-glimpse.js` on a real macOS machine with pi configured, grant Automation/Accessibility access if System Events prompts for it, and only mark item 7 passing if the harness observes the native Glimpse windows and both scenarios succeed there.
