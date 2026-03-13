# Execution Plan: Add Linux support to pi-generative-ui

## Source Inputs
- Execution bundle derived from **SPEC input**.
- Source SPEC (immutable): `.pi/plans/specs/51f72d61.md`
- Repository signals consulted while deriving this bundle: `package.json`, `README.md`, `.pi/extensions/generative-ui/index.ts`
- External implementation references from `pi-coding-agent` (absolute paths, required because future Ralph iterations may start from this repo root):
  - `/home/devkit/projects/pi-mono/packages/coding-agent/README.md`
  - `/home/devkit/projects/pi-mono/packages/coding-agent/docs/extensions.md`
  - `/home/devkit/projects/pi-mono/packages/coding-agent/docs/packages.md`
- `.ralph/items.json` is the source of truth for feature-level status.

Assumptions derived conservatively from the SPEC and repo state:
- No PRD was provided.
- The repo currently has no canonical npm `scripts` for lint, typecheck, test, or build, so verification must begin from direct stack-appropriate commands and any new canonical scripts added during implementation become mandatory gates.
- The primary acceptance environment is WSL2 Ubuntu 24 with WSLg enabled.
- User constraint update (2026-03-13): no real macOS environment is available. By explicit user instruction, Ralph completion is recalibrated to accept a mocked Glimpse adapter verification path on Linux instead of native macOS window verification. The immutable source SPEC remains unchanged and is treated as historical planning input.

## Objective
Implement the approved Linux support design for `pi-generative-ui` so the package can install and run on WSL2 Ubuntu 24 with WSLg, using a compiled Linux webview helper while preserving the existing tool contract and user-controlled widget lifecycle defined in the source SPEC.

## Scope In
- Remove the current darwin-only install blocker from package metadata and dependency flow.
- Introduce a backend abstraction that preserves the existing runtime contract and separates macOS Glimpse behavior from the Linux implementation.
- Add a compiled Linux helper based on `webview/webview` + WebKitGTK with the required JSONL protocol and page bridge.
- Preserve existing `visualize_read_me` and `show_widget` public tool behavior.
- Implement runtime preflight diagnostics for missing display, missing helper binary, missing runtime prerequisites, and WSLg-specific issues.
- Verify the Linux path through a headed interactive `pi` session using the interactive-shell workflow.
- Update package metadata and README/install guidance to reflect Linux + WSLg support and verification expectations.
- Preserve the macOS Glimpse path and capture regression evidence when a macOS environment is available.

## Scope Out
- Windows support.
- Browser-tab or non-native fallback rendering for Linux.
- Rewriting or re-extracting the Claude guideline corpus.
- Renaming public tools or changing their parameter contracts.
- Broad refactors unrelated to Linux support and backend abstraction.
- Any edit to the source SPEC unless the user explicitly asks for it.

## Constraints
- Treat `.pi/plans/specs/51f72d61.md` as immutable source planning input.
- Work one item per Ralph iteration, with one commit and one append-only progress entry per iteration.
- Do not mark an item as passing without executing the verification needed for that item's end-to-end steps.
- Do not skip or weaken checks; no bypass flags, masked failures, or test deletions.
- Use a real embedded webview on Linux; screenshots or browser-tab substitutes do not satisfy the goal.
- Acceptance on Linux requires a headed interactive `pi` instance in WSL2 + WSLg, not only helper-level smoke tests.
- If the current environment cannot verify a required platform-specific item (for example macOS regression), leave that item failing and document the blocker instead of claiming completion.

## Prioritization Strategy
- Prioritize the highest-risk prerequisite item first, not list order: install path, backend abstraction, and Linux runtime integration come before docs or lower-risk cleanup.
- Prefer items that unlock downstream verification in WSL2 + WSLg.
- Keep each iteration scoped to exactly one item that can be completed and verified end-to-end in a single context window.
- Delay README/package polish until the install/runtime path is proven.
- Treat macOS regression verification as a late-stage gate after Linux implementation is stable, unless a macOS environment becomes available earlier.

## Completion Definition
The execution bundle is complete only when all items in `.ralph/items.json` have `passes=true` and all required verification gates succeed with exit code 0 and observed evidence.

For this goal, completion requires:
- Linux install succeeds without `EBADPLATFORM` and produces the helper binary.
- The Linux widget path works in a headed interactive `pi` session in WSL2 + WSLg, including message return, streaming behavior, close/abort semantics, and actionable diagnostics.
- Package metadata and README accurately describe Linux support and verification workflow.
- The macOS Glimpse path preserves backend selection, support checks, open/send/close adapter semantics, and missing-dependency diagnostics through a mocked Glimpse harness runnable on Linux when real macOS hardware is unavailable.
- The source SPEC remains unchanged.
- `.ralph/progress.md` contains one concise append-only entry per completed iteration.
