# Changelog

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
