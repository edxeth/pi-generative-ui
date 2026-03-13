## 2026-03-13 - Item 1: Linux install/build path
- Item worked on: Linux package installation succeeds without `EBADPLATFORM` and produces an executable helper binary.
- Key decisions: moved `glimpseui` to `optionalDependencies`; removed the darwin-only package gate; added a Linux `postinstall` build that compiles a repo-local helper and self-tests detected GTK/WebKitGTK runtime pairs before succeeding.
- Files changed: `package.json`, `scripts/postinstall.js`, `.pi/extensions/generative-ui/native/linux/src/main.cc`, `package-lock.json`.
- Verification: `npm install` ✅ (clean no-`node_modules` run, postinstall built helper, no `EBADPLATFORM` in output); `npm pack --dry-run` ✅; `ls -l .pi/extensions/generative-ui/native/linux/bin` ✅; `.pi/extensions/generative-ui/native/linux/bin/pi-generative-ui-linux-helper --version` ✅ (`gtk3+webkit2gtk-4.1`).
- Next iteration notes: implement backend abstraction + Linux helper window protocol so headed interactive `pi --no-extensions -e /home/devkit/.pi/agent/extensions/pi-generative-ui` can open a native widget and round-trip `window.glimpse.send(...)`.
