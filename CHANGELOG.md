# Changelog

## 0.2.5 — 2026-11-22

- The worker probes the model host before loading the engine. A blocked or
  throttled huggingface.co used to look like a download stuck at 0%: no
  progress, no error, forever. It now fails in ten seconds with the host named,
  and the host can fall back instead of waiting.

## 0.2.4 — 2026-11-22

- `onStateChange(state, detail)` now carries the engine's own failure message, so
  a host can show why an install stopped instead of a generic sentence. Worker
  fetch failures keep their original text.

## 0.2.3 — 2026-11-22

- Default tiers now use q4f16 weights: the compact model drops from 1,129 MB to
  879 MB (Llama-3.2-1B-Instruct-q4f16_1-MLC) and the standard tier from 2,952 MB
  to 2,264 MB, with no measurable quality change on a 1B model.
- `TINY_MODEL` (SmolLM2-360M, 376 MB) is exported for hosts that need the
  smallest possible install.

## 0.2.2 — 2026-11-22

- `detectWebGPU()` asks the browser for an adapter before a host promises an
  on-device model. `navigator.gpu` can exist with no usable GPU (headless
  Chromium, remote sessions), which used to mean a 1.1 GB download ending in a
  failure.

## 0.2.1 — 2026-11-22

- A turn that ends in a surface returns an empty text, and the keyword engine
  stops narrating after one, so the host renders the card without a redundant
  sentence above it.

## 0.2.0 — 2026-11-22

- **Grounding:** `AgentRuntimeOptions.readContext(query)` supplies page content,
  docs, or a transcript for the turn; `buildSystemPrompt` carries it under a
  separate token budget (`contextBudgetTokens`, default 700) and tells the model
  to offer to navigate when the answer lives in a section.
- **`client-agent/dom`:** `createDomContextReader({ sections })` turns visible
  sections into labelled, budgeted text, ranked by the visitor's words. Reads
  `innerText` in a browser and walks the tree where it does not exist.
- **Declarative surfaces:** a handler may return `{ surface: [...] }`; the loop
  emits a `surface` step and hands the messages to the host, which owns the
  catalog and the renderer. The runtime never interprets the component tree.
- 67 tests.

## 0.1.5 — 2026-11-22

- After an action runs, the keyword engine answers with the capability's title
  ("Done: Open the printable resume.") instead of the same "Done. Anything
  else?" every time.

## 0.1.4 — 2026-11-22

- Fixes the keyword engine losing a multi-sentence `{ answer }`: the tool result
  is now parsed per message and anchored to the final full stop, so answers with
  internal periods survive intact.

## 0.1.3 — 2026-11-22

- The keyword engine reads `{ answer }` (or `{ text }`) from a query result and
  replies with that sentence verbatim, instead of flattening every field into
  "key value" pairs. Counts still get the flattened summary.

## 0.1.2 — 2026-11-22

- `CAP007` stops flagging actions whose title opens with a read-only verb
  ("Open the archive", "Export the report") just because the description
  mentions saving or archiving. It now matches the mutating word against the
  id and title only, and skips titles that open, show, read, copy, print,
  download, expand, export, list, find, search, filter or sort.

## 0.1.1 — 2026-11-22

- Route capabilities may now point at a hash (`#projects`) as well as a path
  (`/settings/billing`), so single-page sites and anchor navigation can be
  declared without inventing a router.
- `prepare` script builds `dist` on install from a git URL, so the package can
  be consumed before it is on npm.

## 0.1.0 — 2026-11-22

First cut of the package and the demo.

- `client-agent/core`: `defineCapability`, registry with late registration, JSON Schema subset validator, BM25 retrieval with route boost, prompt assembly with a token budget, tool-call parser, execution loop (schema retry, confirmation gate, step cap, navigate-then-wait), deterministic lexical engine.
- `client-agent/build` + `client-agent/cli`: TypeScript-AST extraction of literal declarations, deterministic `agent-manifest.json`, 10 diagnostic codes, `verify` / `manifest` / `codes` / `init --skill`, and a self-check runner over 9 fixtures.
- `client-agent/vite`: build plugin emitting the manifest plus a `client-agent:manifest` virtual module, with a dev watcher.
- `client-agent/react`: `<AgentProvider>`, `useAgentChat`, `useRegisterCapability`.
- `client-agent/webllm`: WebGPU worker, engine bridge with progress and lazy load, `createAutoEngine` fallback.
- `apps/demo`: Ledger invoices app, five routes, twelve capabilities, keyword and on-device modes.
