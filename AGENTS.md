# AGENTS.md

Guidance for AI coding agents working in `antigravity-auto-rename`.

## Project Overview

`antigravity-auto-rename` is a cross-platform (macOS, Windows, Linux) Antigravity plugin that intercepts and customizes conversation naming without modifying Antigravity's `app.asar` or requiring external API keys.

- **Runtime**: Pure Node.js ESM (`"type": "module"`, `node >= 18.0.0`) using built-in `node:*` modules only — **keep zero external npm runtime dependencies**.
- **Plugin manifests**: [plugin.json](plugin.json), [.antigravity-plugin/plugin.json](.antigravity-plugin/plugin.json), [hooks.json](hooks.json), and [sidecars/panel/sidecar.json](sidecars/panel/sidecar.json).

## Repository Layout

- `hooks/on-hook.mjs` — Fast synchronous `PreInvocation` / `Stop` hook entrypoint. Reads stdin JSON, detached-spawns `hooks/worker.mjs`, and immediately prints `{}` (`pre`) or `{"decision":"allow"}` (`stop`) to stdout so agent execution is never blocked.
- `hooks/worker.mjs` — Background hook worker that extracts conversation context, updates turn tracking, evaluates `shouldTriggerAutoRename`, and calls `executeConversationRename`.
- `sidecars/panel/main.mjs` — Sidecar HTTP server (runs via `sidecar_sdk` inside Antigravity or standalone `http` server on `127.0.0.1:$PORT`), serves panel UI assets, exposes `/api/*` routes, and runs `runWatcherSweep()` every `4000ms` (`WATCHER_INTERVAL_MS`).
- `sidecars/panel/core/config.mjs` — Default settings (`DEFAULT_SETTINGS`), schema clamping/merging (`sanitizeSettings`, `loadSettings`, `saveSettings`), conversation state persistence (`loadState`, `getConversationState`, `updateConversationState`), and runtime asset bundle fingerprinting (`computeRuntimeCodeVersion`).
- `sidecars/panel/core/prompt-builder.mjs` — XML/system tag sanitization (`cleanUserMessageText`), opening-language detection (`detectInitiationLanguage`), transcript context extraction (`extractConversationContext`), prompt construction (`buildRenamePrompt`), and title post-processing (`buildQuickFallbackTitle`, `postprocessGeneratedTitle`).
- `sidecars/panel/core/rename-engine.mjs` — Trigger policy (`shouldTriggerAutoRename`), turn-1 title preemption + AI title generation (`executeConversationRename`), and title restore (`undoConversationRename`).
- `sidecars/panel/core/ls-client.mjs` — Cross-platform Antigravity Language Server discovery (`language_server` + `--csrf_token`, or `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`), Connect JSON RPC helpers (`GetUserStatus`, `GetModelResponse`, `UpdateConversationAnnotations`), and brain transcript loading.
- `sidecars/panel/core/window-bridge.mjs` — Non-invasive Electron CDP controller (`DevToolsActivePort`) and authenticated loopback bridge serving the main-window titlebar capsule (`#ag-auto-rename-capsule`).
- `sidecars/panel/web/` — Aux Pane UI (`index.html`, `app.js`, `styles.css`) and CDP-injected titlebar capsule (`overlay.js`).
- `test/rename-engine.test.mjs` — `node --test` unit and hook-contract test suite.

## Architecture & Critical Invariants

1. **Non-blocking hooks**
   - `hooks/on-hook.mjs` must exit immediately with the valid JSON hook contract (`{}` on `pre`, `{"decision":"allow"}` on `stop`). Never perform network RPCs or long I/O synchronously inside `on-hook.mjs`.
   - `hooks/worker.mjs` must fail silently so host agent loops are never disrupted.

2. **Settings persistence & partial updates**
   - Data directory resolution in `resolveDataDir()` prefers `AUTO_RENAME_DATA_DIR || PLUGIN_DATA`, falling back to `~/.gemini/antigravity/auto-rename`.
   - `POST /api/settings` calls `saveSettings(patch)` -> `sanitizeSettings(patch, current)`, preserving omitted keys. Quick-save controls in `overlay.js` intentionally send single-field patches (e.g. `{ autoRenameInterval }` or `{ customPromptRules }`) — keep UI controls from overwriting unrelated settings or saving before initial `/api/status` load completes (`hasLoadedSettings` guard in `sidecars/panel/web/app.js`).

3. **Prompt sanitization & language lock**
   - `cleanUserMessageText()` must strip paired Antigravity system/metadata XML blocks (`ADDITIONAL_METADATA`, `CONTEXT_SUMMARY`, `USER_SETTINGS_CHANGE`, `SYSTEM_MESSAGE`, `IDE_CONTEXT`, `ENVIRONMENT_DETAILS`), `</?USER_REQUEST>` wrappers, and leading `/command ` prefixes before running `detectInitiationLanguage()` or building prompts.
   - Multi-turn renames keep turn 1 (`firstUserMessage`) anchored for initiation language detection while appending recent `contextRecentTurns` user turns and optional assistant snippet.

4. **Watcher timing & multi-turn triggers**
   - `runWatcherSweep()` acts as a 4s safety net alongside hooks. When `settings.triggerTiming === 'stop'` on a multi-turn conversation (`turns > 1`) whose status matches `/RUNNING/i`, it passes `eventPhase: 'pre'` so `shouldTriggerAutoRename()` waits for the `Stop` hook or idle completion rather than renaming mid-turn.

5. **Non-invasive CDP overlay isolation**
   - Never patch Antigravity's `app.asar` or application binaries.
   - Keep CDP globals, bridge headers, and DOM selectors strictly namespaced to this plugin (`__AGAutoRenameBridge`, `__AGAutoRenameOverlay`, `X-Auto-Rename-Token`, `#ag-auto-rename-capsule`) so other plugins coexist safely.
   - `computeRuntimeCodeVersion()` checks `overlay.js`, `styles.css`, and `main.mjs` mtimes; `onVersionDrift` exits Sidecar `main.mjs` cleanly so Antigravity's `restart_policy: "always"` respawns it. Note that edits solely to `sidecars/panel/core/*.mjs` do not change `computeRuntimeCodeVersion()` and require restarting the Sidecar process (or touching `main.mjs`) for a running Sidecar instance to reload them, whereas `hooks/on-hook.mjs` / `worker.mjs` load fresh modules per turn.

## Development & Verification

- Run the full test suite before finishing any code change:
  ```bash
  npm test
  ```
- Tests use Node's built-in test runner (`node --test test/*.test.mjs`). Isolate any new tests with temporary directories via `mkdtempSync` and `AUTO_RENAME_DATA_DIR` / `ANTIGRAVITY_BRAIN_DIR` (or explicit `configFile` / `stateFile` arguments) so the developer's live `~/.gemini/antigravity/` data is never mutated.
- You can run the Sidecar UI locally in standalone mode for manual inspection:
  ```bash
  PORT=0 node sidecars/panel/main.mjs
  ```

## Documentation & Metadata Hygiene

- Keep `plugin.json` and `.antigravity-plugin/plugin.json` aligned (name, version, description, repository).
- Keep `README.md` bilingual (Simplified Chinese and English) when changing user-facing settings, shortcuts, or installation instructions.
