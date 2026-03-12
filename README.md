# pi-generative-ui

Claude.ai's generative UI - reverse-engineered, rebuilt for [pi](https://github.com/badlogic/pi).

Ask pi to "show me how compound interest works" and get a live interactive widget - sliders, charts, animations - rendered in a native macOS window. Not a screenshot. Not a code block. A real HTML application with JavaScript, streaming live as the LLM generates it.

https://github.com/user-attachments/assets/placeholder-demo-video

## How it works

On claude.ai, when you ask Claude to visualize something, it calls a tool called `show_widget` that renders HTML inline in the conversation. The HTML streams live - you see cards, charts, and sliders appear as tokens arrive.

This extension replicates that system for pi:

1. **LLM calls `visualize_read_me`** - loads design guidelines (lazy, only the relevant modules)
2. **LLM calls `show_widget`** - generates an HTML fragment as a tool call parameter
3. **Extension intercepts the stream** - opens a native macOS window via [Glimpse](https://github.com/hazat/glimpse) and feeds partial HTML as tokens arrive
4. **[morphdom](https://github.com/patrick-steele-idem/morphdom) diffs the DOM** - new elements fade in smoothly, unchanged elements stay untouched
5. **Scripts execute on completion** - Chart.js, D3, Three.js, anything from CDN

The widget window has full browser capabilities (WKWebView) and a bidirectional bridge - `window.glimpse.send(data)` sends data back to the agent.

## Install

```bash
pi install git:github.com/user/pi-generative-ui
```

> macOS only. Requires Swift toolchain (ships with Xcode or Xcode Command Line Tools).

## Usage

Just ask pi to visualize things. The extension adds two tools that the LLM calls automatically:

- **"Show me how compound interest works"** → interactive explainer with sliders and Chart.js
- **"Visualize the architecture of a transformer"** → SVG diagram with labeled components  
- **"Create a dashboard for this data"** → metric cards, charts, tables
- **"Draw a particle system"** → Canvas animation

The LLM decides when to use widgets vs text based on the request. Explanatory/visual requests trigger widgets; code/text requests stay in the terminal.

## What's inside

### The guidelines - extracted from Claude

The design guidelines aren't hand-written. They're **extracted verbatim from claude.ai**.

Here's the trick: you can export any claude.ai conversation as JSON. The export includes full tool call payloads - including the complete `read_me` tool results containing Anthropic's actual design system. 72K of production rules covering typography, color palettes, streaming-safe CSS patterns, Chart.js configuration, SVG diagram engineering, and more.

We triggered `read_me` with each module combination, exported the conversation, parsed the JSON, split the responses into deduplicated sections, and verified byte-level accuracy against the originals. The result: our LLM gets the exact same instructions Claude gets on claude.ai.

Five modules, loaded on demand:

| Module | Size | What it covers |
|---|---|---|
| `interactive` | 19KB | Sliders, metric cards, live calculations |
| `chart` | 22KB | Chart.js setup, custom legends, number formatting |
| `mockup` | 19KB | UI component tokens, cards, forms, skeleton loading |
| `art` | 17KB | SVG illustration, Canvas animation, creative patterns |
| `diagram` | 59KB | Flowcharts, architecture diagrams, SVG arrow systems |

### Streaming architecture

The extension intercepts pi's streaming events (`toolcall_start` / `toolcall_delta` / `toolcall_end`) to render the widget live as tokens arrive:

```
toolcall_start    → initialize streaming state
toolcall_delta    → debounce 150ms, open window, morphdom diff
toolcall_end      → final diff + execute <script> tags
execute()         → reuse window, wait for interaction or close
```

Key details:
- **Shell HTML + JS eval** - window opens with an empty shell; content injected via `win.send()`, not `setHTML()`, to avoid full-page flashes
- **morphdom DOM diffing** - only changed nodes update; new nodes get a 0.3s fade-in animation
- **pi-ai's `parseStreamingJson`** - no need for a partial JSON parser; pi already provides parsed `arguments` on every delta
- **150ms debounce** - batches rapid token updates for smooth visual rendering
- **Dark mode by default** - `#1a1a1a` background, designed for macOS WKWebView

### Glimpse

[Glimpse](https://github.com/hazat/glimpse) is a native macOS micro-UI library. It opens a WKWebView window in under 50ms via a tiny Swift binary. No Electron, no browser tab, no runtime dependencies beyond the system WebKit.

The Swift source compiles automatically on `npm install` via `postinstall`.

## Project structure

```
pi-generative-ui/
├── .pi/extensions/generative-ui/
│   ├── index.ts              # Extension: tools, streaming, Glimpse integration
│   ├── guidelines.ts         # 72K of verbatim claude.ai design guidelines
│   └── claude-guidelines/    # Raw extracted markdown (reference)
│       ├── art.md
│       ├── chart.md
│       ├── diagram.md
│       ├── interactive.md
│       ├── mockup.md
│       └── sections/         # Deduplicated sections
└── package.json              # pi-package manifest
```

## How the guidelines were extracted

1. Start a conversation on claude.ai that triggers `show_widget`
2. Call `read_me` with each module combination (`art`, `chart`, `diagram`, `interactive`, `mockup`)
3. Export the conversation as JSON from claude.ai settings
4. Parse the JSON - every `tool_result` for `visualize:read_me` contains the complete guidelines
5. Split each response at `##` heading boundaries
6. Deduplicate shared sections (e.g., "Color palette" appears in chart, mockup, interactive, diagram)
7. Verify reconstruction matches the originals (4/5 exact, 1 has a single whitespace char difference)

The raw `read_me` responses are preserved in [`claude-guidelines/`](.pi/extensions/generative-ui/claude-guidelines/) - the original markdown exactly as claude.ai returned it, before splitting and deduplication. The conversation export JSON is not included in this repo.

## Credits

- [pi](https://github.com/badlogic/pi) - the extensible coding agent that makes this possible
- [Glimpse](https://github.com/hazat/glimpse) - native macOS WKWebView windows
- [morphdom](https://github.com/patrick-steele-idem/morphdom) - DOM diffing for smooth streaming
- Anthropic - for building the generative UI system we reverse-engineered

## License

MIT
