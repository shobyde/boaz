# Changelog

## 0.6.10 — 2026-11-24

- `analyzeQuestion()` fills `slots.exclude`: the declared subjects inside a
  negation scope, for "not python", "anything but hobnob", "excluding the
  archive", "other than", "besides", "apart from", "without". A negated subject
  is removed from `entities`, because the visitor is asking about everything
  else, and stays in `mentions` so an app can still acknowledge the word.
- Scope ends at a sentence end or "but", and at a comma only when a new question
  or command follows, so "not the archive, take me to the blog" excludes one
  thing and still navigates. Idioms ("not sure", "not to like", "why not") and
  negation-shaped words with no subject after them ("no model") produce no
  exclusion.
- The rules engine never asserts `asked()` for a constant the question ruled
  out, so "which projects use sqlite but not python" no longer answers with the
  Python projects. `AnswerContext.exclude` carries the list, and
  `EngineMemory.excludes` reports it for a debug panel.
- 149 tests (5 new).

## 0.6.9 — 2026-11-24

- `analyzeQuestion(query, { subjects, attributes })` in `client-agent/core`
  classifies a question's shape (`who`, `what`, `where`, `when`, `how-many`,
  `which`, `why`, `compare`, `unknown`) from ordered cue patterns, and fills the
  slots a router acts on: the declared subjects it names (matched through
  `tokenize`, so `SQLite` and `sqlite` agree), the attribute asked about
  (stack, writing, contact, count, date, location, identity, reason, projects),
  a recency qualifier, whether it refers back instead of naming something, and
  the content words nothing accounted for.
- `contested` names the runner-up frame when it is within a point, because
  "what year did Hobnob ship" is a `when` by one cue and the label is a
  judgement, not a fact.
- It classifies the question, not the request. "Take me to the archive" and
  "copy his email" stay `unknown` so the engine's controller verbs keep
  deciding that; a caller must not use `type` to override them.
- 144 tests (9 new).

## 0.6.8 — 2026-11-23

- `client-agent/probes` is its own entry point. `client-agent/build` re-exports
  `generateProbes`, but importing it in a browser drags in the scanner and with
  it `typescript`; the generator itself is pure and does not need either. The
  shipped probe generator page imports this entry.

## 0.6.7 — 2026-11-23

Coverage before anyone writes a probe by hand.

- `client-agent probes --generate --manifest <file>` turns a manifest into
  `probes.generated.json`: one question per capability title and keyword, each
  expecting the capability it came from and grouped under it as an `intent`, so
  `audit` runs immediately and `bench` can score the copy once `must` facts are
  added. `--out`, `--titles-only`, `--keywords-only`, `--force` (it refuses to
  overwrite an existing probe file).
- A route probe is written as a request ("take me to faq"), because naming a
  destination is not asking to go there.
- Two capabilities in the same query class claiming one phrase are reported, not
  emitted: whichever answered, the probe would be recording a coin flip. A
  knowledge entry and a route may still share a phrase, since their probes take
  different forms and the engine decides question vs request first.
- A capability with required parameters is reported with `needsArgs` instead of
  guessed: a phrase names what to open, not which one.
- `generateProbes`, `serializeProbes` and `normalizePhrase` are exported from
  `client-agent/build`, so a browser can generate the same file.
- 135 tests.

## 0.6.6 — 2026-11-23

Testing comes with the package.

- `client-agent audit --probes <file> --module <file>`: ask every probe, report the engine's own decision
  (the rule that planned a tool call, the capability that ran, the knowledge paragraph quoted), exit 1 on a
  miss. `--json` for CI.
- `client-agent bench --probes <file> --module <file> [--samples]`: fidelity, paraphrase similarity with the
  facts masked, opener variety, length spread, stability. Only intents with a `must` list are scored.
- `agent-setup.mjs` contract: `createEngine()` plus optional `runCapability`, `answers`, `capabilities`.
  `runCapability` is what lets a rule that reads a tool answer with a sentence in the harness.
- `EngineMemory.planned`: which rule planned the call this turn. Without it a harness cannot tell
  "the rule asked for projects.list" from "the keyword engine happened to pick projects.list".
- `controllerVerbs`: apps add their own command verbs ("filter", "sort") so answer rules stay out of them.
- A rule that joins `asked(?T)` is the only kind that waits for a subject; listing rules run when matched.
- Default rule threshold scales with the number of rules (×0.35, floor 0.35): with one rule the best
  possible phrase match scores ~1.2, so a flat 1.0 threshold silently dropped real matches.
- The shipped skill now covers answers, phrasing and both commands; `init --skill` writes it.
- 125 tests.

## 0.6.5 — 2026-11-23

- `constants` option and `KnowledgeBase.declare()`: an app can declare the values a tool will return, so
  "what's built with python?" is recognised before the project list has been read. Rules that join on
  `asked(?T)` are shortlisted whenever the question names one of those values.
- `AnswerRule.match(query)`: an explicit trigger for questions keyword matching cannot see. "What does he
  do?" is all stopwords, so it tokenizes to nothing and no BM25 score can reach it.
- 117 tests.

## 0.6.4 — 2026-11-23

- A rule that joins on `asked(?T)` gets a 1.4 boost when the question names a declared constant. "What's
  built with Python?" and "any projects in python?" were losing to the plain project-list rule because
  the verbose rule about listing had more keywords in common.
- 115 tests.

## 0.6.3 — 2026-11-23

- Narrow 0.6.2 to `much` and `many`. Treating `more`, `about`-style quantifiers as stopwords broke
  "more about groundglass", which needs "more about" to reach the expand action.
- 115 tests.

## 0.6.2 — 2026-11-23

- Quantifiers are stopwords. "How much has he written?" was matching the project-stack rule through the
  word "much" and answering "No project stack lists much."
- 115 tests.

## 0.6.1 — 2026-11-23

- `requiresSubject: false` on an answer rule: a listing rule ("what has he built") has nothing to look
  up but should still run, where a lookup rule ("which projects use TypeScript") waits for a subject.
- 115 tests.

## 0.6.0 — 2026-11-23

- A rule with tool steps only plans them when the question has a subject of its own. "What is his
  stack?" was calling projects.list before the keyword engine answered the actual question; a
  technology nobody lists ("TypeScript") still counts as a subject, so that answer survives.
- 114 tests.

## 0.5.9 — 2026-11-23

- Pronouns and auxiliaries are stopwords. With a handful of capabilities, a rare word inflates IDF:
  "where is he based?" was matching an answer rule about "what has he built" on the word "he".
- A navigation request searches past the shortlist for the best route ("show me the blog" was routing
  to the newest-article card), and a verb match now weights 1.5, enough to separate "open the project
  site" from "show the project card".
- 114 tests.

## 0.5.8 — 2026-11-23

- Verb boost now feeds the scores that confidence, margins and suggestions use, instead of only the
  sort order, so "read the newest article" stops losing to the card with the same nouns.
- A navigation request resolves to the best route that clears the threshold, even when an action about
  the same noun looks confident ("show me the blog" opened the newest article card).
- A two-word question no longer inherits the previous rule: "where is he based?" was firing the last
  project rule because short queries were treated as ellipsis.
- "see …" counts as a controller request, so the archives question reaches the archive action.
- 114 tests.

## 0.5.7 — 2026-11-23

- Answer rules stay out of controller requests. "Show me the archive" and "open the newest article"
  are things the app should do, not questions for the knowledge base; a rule matching on the nouns
  used to hijack them and call the wrong capability.
- The keyword engine boosts a capability whose title opens with the visitor's verb ("expand" prefers
  "Expand a project card" over "Show a project card"), and treats "show me the blog" as navigation
  unless the sentence names a thing to show.
- A question ("who is Sho") prefers a knowledge answer over a route within reach, instead of asking
  the visitor to choose between an answer and a scroll.
- 114 tests.

## 0.5.6 — 2026-11-23

- A query result summarized as a sentence names its records: an array of objects is described by its
  `title`/`name`/`id` ("3 items (Hobnob, Readback, Groundglass…)"), so "projects [object Object]" can
  no longer reach a visitor.
- Answer context gains `mentions`: the surface words the question used that no fact or rule metadata
  accounted for. That is what lets a rule say "No project stack lists TypeScript" instead of falling
  through to the keyword engine when the data genuinely does not have the thing.
- 114 tests.

## 0.5.5 — 2026-11-23

- A `toFacts` adapter that throws is no longer swallowed. The failure becomes an `error` step in the
  completion, so a broken adapter shows up in the trace instead of silently degrading every answer to
  keyword matching. A missing helper survived a whole deploy that way.
- 112 tests.

## 0.5.4 — 2026-11-23

- No reply can be raw JSON. The keyword engine preferred the clipped transcript copy of a tool result,
  failed to parse it, and echoed the payload at the visitor; it now reads the structured observation
  the runtime supplies, and an unparseable payload becomes "I read that data, but it came back too
  large to summarise" instead of a JSON dump.
- 111 tests.

## 0.5.3 — 2026-11-23

- `EngineRequest.observations` carries this turn's tool results structurally. The transcript copy is
  clipped to a prompt budget, so a large result (a project list with full stacks) arrived as
  truncated JSON, failed to parse, and the answer degraded to an echo of the payload. Engines that
  reason over tool data now get the whole value; the transcript parse stays as a fallback.
- 109 tests.

## 0.5.2 — 2026-11-23

- A follow-up that names a term the data does not have ("and SQLite?" when no stack lists it) no
  longer repeats the previous answer. Carry-over now applies only to true ellipsis ("and?", "why?"),
  where the query has no subject of its own.
- 108 tests.

## 0.5.1 — 2026-11-23

- The knowledge base indexes constants with the retriever's tokenizer, so a question word and the
  constant it names actually meet ("sqlite" and "SQLite" both stem to the same token). They used two
  different tokenizers, which silently broke term resolution for every word the stemmer touched.
- 107 tests.

## 0.5.0 — 2026-11-23

Grounding, conversation memory and tool reasoning: the three things that made the deterministic
engine feel narrow.

- **`client-agent/extract`**: `createFieldScanner()` reads email / LinkedIn / URL / phone out of text
  the host already has, with a sentence of evidence. `requestedFields(query)` decides when a question
  is asking for one. This is the fallback for values nobody declared.
- **Grounding in the rules engine**: `grounding.read(query)` supplies page text; matched fields
  arrive as `field(<kind>, <value>)` assumptions, so a rule can prefer declared facts and fall back
  to what the page says (`email(?V) :- field(email, ?V).`).
- **Conversation memory**: a follow-up inherits the previous intent and terms ("which projects use
  python?" then "and SQLite?"), a bare "and?" repeats the last rule with its assumptions, and a
  follow-up that names a different field switches rules instead of dragging the old one along.
- **Tool reasoning**: an answer rule can declare `steps: [{ capabilityId, toFacts }]`. The engine
  emits the capability call, reads the result out of the turn, converts it to facts with `toFacts`,
  and runs the goal over declared facts + live data. One call per turn, in order, with the plan in
  the app and the loop in the library.
- Terms are resolved after the tools have run, so a vocabulary that only exists in a tool result
  can still match the visitor's words.
- 106 tests.

## 0.4.4 — 2026-11-23

- Answer rules can declare `explain(context)`, one plain-language line describing what the rule did
  ("Checked 5 project stacks for Python: found it in Readback, Groundglass"). It travels on the
  `inference` step as `label`, so a host never has to print a Datalog goal at a visitor.
- `streaming` accepts `leadInMs`: a pause before the first delta so the trace is readable before the
  answer starts. Skipped when the tab is hidden, like the per-chunk pacing.
- 91 tests.

## 0.4.3 — 2026-11-23

- A matched answer rule now composes even when its goal finds nothing, so "which projects use
  TypeScript" can reply "No project lists TypeScript" instead of falling through to unrelated prose.
  Returning an empty string still declines the turn to the next engine.
- 89 tests.

## 0.4.2 — 2026-11-23

- Streaming no longer crawls in a background tab. Browsers throttle `setTimeout` to roughly once a
  second when the page is hidden, so a paced reply took seconds to finish after the visitor switched
  tabs; the runtime now skips the pause when `document.hidden` and still paces in the foreground.
- 88 tests.

## 0.4.1 — 2026-11-23

- `createLexicalEngine()` answers navigation requests by destination. "Take me to the projects"
  used to lose a margin contest to "List projects" and "Show a project card" and come back as
  "I'm not sure"; verbs like take me / go to / jump to / scroll to now resolve to the best route
  that clears the threshold. Controller requests ("show only the overdue invoices") are untouched.
- 88 tests.

## 0.4.0 — 2026-11-23

Breaking: the model adapters are gone.

- **Removed** `client-agent/webllm`, `client-agent/webllm/worker`, `client-agent/chrome-ai`, the
  `@mlc-ai/web-llm` peer dependency and the demo worker. No download, no WebGPU requirement, no
  Prompt API. A visitor gets an answer on any browser.
- **New `client-agent/rules`**: `KnowledgeBase` holds facts and Datalog rules
  (`head(?X) :- body(?X, ?Y), asked(?Y)`), evaluates them with scoped per-query assumptions, a
  depth limit and deduped solutions.
- **`createRulesEngine()`** picks an answer rule by BM25 over its title and keywords, runs the goal,
  composes the reply through the app's `compose` callback, and returns an `inference` step carrying
  the goal, the matched terms, the solutions and the rule text. It falls through to keyword matching
  when no rule applies or `compose` declines.
- **Streaming**: `AgentRuntime` takes `streaming: { chunkChars, paceMs }` and emits `delta` events
  before the `turn` event. The reply is already computed; this is pacing, not inference.
- `EngineCompletion` may now carry `steps`, so any engine can report what it did.
- 86 tests, including rule joins, recursive rules, scoped assumptions, and delta ordering.

## 0.3.6 — 2026-11-23

- Static metadata may be wrapped with string concatenation (`'a ' + 'b'`).
  The scanner folds those operands, so a knowledge paragraph or a long
  description broken across source lines is read instead of failing the scan
  as CAP006 "cannot read this declaration statically".
- 86 tests.

## 0.3.5 — 2026-11-23

- The build-time scanner recognises `defineKnowledge()` and its import alias,
  defaults those declarations to kind `knowledge`, and copies the `knowledge`
  text into the manifest. 0.3.4 added the kind to the runtime and the
  declaration helper, but the extractor still only looked for
  `defineCapability`, so knowledge entries were silently missing from every
  generated manifest and the lexical engine never saw them.
- 85 tests.

## 0.3.0 — 2026-11-22

- **`client-agent/chrome-ai`**: an engine over the browser's own on-device model
  (Chrome's Prompt API). `detectChromeAI()` reports available / downloadable /
  downloading / unavailable / unsupported, `createChromeAIEngine().prepare()`
  fetches the model if the browser has to, and `complete()` flattens the
  conversation into one prompt. When the browser already has the model there is
  no network request at all, which matters on networks where the model host is
  blocked.
- 74 tests.

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
