# pi-generative-ui

Native generative UI for [pi](https://github.com/badlogic/pi).

Ask pi to explain something visually and it can open a real native window with HTML, SVG, charts, sliders, buttons, and JS-driven interactions — streamed live while the model is still generating.

## What it does

- opens native widget windows on **macOS and Linux**
- uses **upstream [Glimpse](https://github.com/hazat/glimpse)** as the runtime on both platforms
- preserves the Claude-style flow:
  - `visualize_read_me`
  - `show_widget`
  - streaming partial UI before final completion
  - `window.glimpse.send(data)` back to pi
  - `sendPrompt(...)` / follow-up prompt bridge

If the model wants a chart, a calculator, a diagram, or a tiny app, it can build one instead of dumping markup into chat.

## Install

```bash
pi install git:github.com/Michaelliv/pi-generative-ui
```

Or test the local repo directly:

```bash
pi --no-extensions -e /absolute/path/to/pi-generative-ui
```

## Platform support

### macOS
Works through upstream `glimpseui`.

### Linux
Works through upstream `glimpseui` too.

**Verified path:** WSL2 Ubuntu 24 with WSLg.

Native Linux desktops may work, but the verified acceptance environment is WSL2 Ubuntu 24 + WSLg.

## Linux prerequisites

Glimpse on Linux needs GTK4 + WebKitGTK 6.0 build/runtime dependencies.

```bash
sudo apt install -y \
  build-essential meson ninja-build \
  libwayland-dev wayland-protocols \
  libgtk-4-dev libwebkitgtk-6.0-dev \
  gobject-introspection libgirepository1.0-dev \
  gtk-doc-tools python3 valac
```

Then:

```bash
npm install
npm --prefix node_modules/glimpseui run build:linux
```

### Important Ubuntu 24 note

Default Ubuntu 24 repos may not provide `gtk4-layer-shell-0` / `libgtk4-layer-shell-dev`.

If that blocks the build, use one of these paths:
- point `GLIMPSE_BINARY_PATH` / `GLIMPSE_HOST_PATH` at a prebuilt Glimpse Linux host
- or build/install upstream `gtk4-layer-shell`, then build Glimpse locally

## What the experience looks like

A typical run looks like this:

1. the model loads design guidance with `visualize_read_me`
2. it starts `show_widget`
3. the native window opens early
4. partial UI streams in while the tool call is still in progress
5. final scripts run once
6. the widget sends data back with `window.glimpse.send(...)`

Supported widget types include:
- Chart.js charts
- sliders and controls
- calculators and dashboards
- SVG diagrams
- Canvas animations
- small interactive tools and forms

## Quick verification

Launch pi against the repo:

```bash
pi --no-extensions -e /absolute/path/to/pi-generative-ui
```

Then use a prompt like:

```text
Create a native interactive widget that proves real-time streaming.
Use visualize_read_me first, then show_widget.
Build a dark widget with a slider, a Chart.js line chart, and a button that calls window.glimpse.send({ ok: true }).
Make the UI appear in obvious stages instead of all at once.
```

What you should see:
- the window opens before the tool finishes
- UI appears progressively
- the chart renders
- the slider updates live
- clicking the button returns data into pi

## Architecture

This repo is intentionally small.

```text
src/
├── index.ts              # extension runtime, streaming, lifecycle, tool rendering
├── backend/              # Glimpse adapter + support diagnostics
├── guidelines.ts         # extracted design guidance
└── claude-guidelines/    # raw reference material
```

No in-house Linux window backend remains in the production path.
Linux and macOS both go through upstream Glimpse.

## Known rough edges

- Linux stderr noise from GTK/Mesa can still appear in the pi terminal on some setups because it comes from upstream Glimpse/WebKitGTK, not from widget code.
- The verified Linux story is strong on WSL2 Ubuntu 24 + WSLg; other Linux environments are best-effort unless separately validated.

## Why this package exists

Claude’s generative UI is one of the best parts of the product. This package brings that interaction model to pi without requiring a browser tab: native windows, live streaming, and real bidirectional widget interaction.

## License

MIT
