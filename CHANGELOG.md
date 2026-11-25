# Changelog

## 0.8.5 - 2026-11-25

- A name that is the word beats a name that contains it. With 0.8.4's `cpp` spelling, a stack value
  `C++` and a project titled `C++ physics simulation engines` both indexed the word, so
  `canonicalFor('cpp')` returned both and the engine asserted `asked()` for the title as well. The
  answer to "which projects use c++" read "C++ physics simulation engines is the one project listing
  C++ physics simulation engines", and the trace called it a two-condition question. `canonicalFor`
  now prefers the candidate whose whole tokenisation is the token; the longer name stays reachable by
  its other words (`physics`, `engines`) and by its joined spelling.
- Suite: 281 tests (1 new). Site discourse held at 20/20 and every other class unchanged.

## 0.8.4 - 2026-11-25

- A technology whose name is punctuation can be named. `tokenize('C++')` and `tokenize('C#')` both
  returned `[]`: the split left `c` and the two-character floor dropped it, so no question could reach
  the stack entry that spells the technology. `normalizeSpelling()` maps `C++` to `cpp` and `C#` to
  `csharp` before the split, and every path that compares visitor words with a declared constant calls
  it first (`tokenize`, `subjectTokens`, the constant index and its joined form), so the query and the
  constant agree without either side being spelled out in a second table. Version numbers keep their
  behaviour: `tokenize('Python 3.10+')` is still `python` + `10`.
- The bare letter stays distinct: `canonicalFor('c')` is `[]` while `canonicalFor('c++')` is `C++`, so
  the normalisation is a spelling and not a fragment.
- Suite: 280 tests (2 new). On the site, discourse 18/19 -> 19/19 (the `which projects use c++` task
  was the one remaining miss); routing 52/52, compound, answers, threads and the handbook arena held.

## 0.8.3 - 2026-11-25

- A camel-case fragment is no longer a name. `tokenize("WebGL")` is `web` + `gl`, and the constant
  index used to key every fragment, so "which projects use python and have a web interface" bound
  Three.js (WebGL) to the word "web" and answered with a project that lists no Python. The index now
  keeps each word's whole spelling (`webgl`, `typescript`, `a2ui`) and drops the fragments, and
  `subjectTokens` joins a camel-case word the same way, so slot, span and exclusion scope agree.
- The other half of the same bug: the whole spelling of a camel-case constant was unreachable, so
  "which projects use webgl" answered "No project on this page lists webgl" while "web" answered
  with it. `canonicalFor('webgl')` now resolves, and so does `a2ui`, which was the rung-6 ceiling
  (a two-word declared constant unreachable by its first word).
- Measured on the site's suites: compound answered set 21/23 -> 23/23, discourse 15/19 -> 16/19 (the
  `a2ui` task), compound slots 25/25, routing 52/52, composition fidelity 100% / similarity 0.50.
  Threads stayed 32/32 after the site learned the third case: a two-condition ask where one condition
  is not a page value now answers the half it has, and "why not both?" says which condition the
  stacks do not list instead of routing those words into an unrelated paragraph.

## 0.8.2 - 2026-11-24

- Releasing is one tag. `.github/workflows/release.yml` installs, builds, tests, checks that the tag
  matches `packages/boaz/package.json`, packs the tarball, attaches it to the GitHub release and
  publishes `@shobyde/boaz` to npm with provenance. Auth is trusted publishing over OIDC when the
  repo variable `NPM_TRUSTED_PUBLISHER` is `true`, otherwise the `NPM_TOKEN` secret.
- `NPM_STAGE=true` flips the same step to `npm stage publish`, which defers the publish to a human
  running `npm stage approve <stage-id>`. Staging never needs a 2FA prompt, so a plain token can do
  it; the approval is where proof-of-presence happens.
- A tag whose version is already on the registry reports "already published" and exits 0, so
  re-running a release is a no-op instead of a red run.

## 0.8.1 - 2026-11-24

- The package publishes as `@shobyde/boaz`. npm's typo-squatting filter refuses the unscoped name
  outright (`Package name too similar to existing packages boom,b4a,btoa,soap,coz,docz,koa`), so the
  scope keeps the name and the registry accepts it. Imports move with it: `@shobyde/boaz/core`,
  `@shobyde/boaz/rules` and the rest. The bin is still `boaz`, so `npx boaz init --skill` is
  unchanged once the package is installed, and `publishConfig.access` is `public` in the manifest.
- Releases are staged, not published, by CI. `npm stage publish` needs no 2FA, so the workflow can
  run unattended while the publish itself stays a human act: the tag stages a version, the summary on
  the run carries the stage id, and `npm stage approve <stage-id>` (with an authenticator) is what
  makes it installable. Auth is a trusted publisher over OIDC when `NPM_TRUSTED_PUBLISHER` is `true`,
  otherwise an `NPM_TOKEN` granular token, which no longer needs 2FA bypass because nothing in the
  pipeline publishes directly.
- The tarball is now attached to the GitHub release before the npm step, so a failed stage still
  leaves an installable release instead of skipping the upload.
- `bin[boaz]` lost its `./` prefix. npm stripped it on every publish and reported the value as
  "invalid and removed", which read as though the CLI had been dropped from the package.

## 0.8.0 - 2026-11-24

- Facts can now be ranked, not only joined. `rankFacts(facts, { relation, attribute, direction })`
  reads the number inside a value ("99.95%", "400 days", "tier 2") and returns the contenders in
  order; `topFact()` is the winner. A row with no number is not a contender rather than a zero, so
  "unknown" can never win a maximum.
- `createFactIndex(facts)` is BM25 over the fact sentences themselves, for the questions that name a
  topic and not a subject: "what happens during a sev 1", "how long are audit logs kept". It shares
  the tokenizer and the stoplist with the capability index, and its floor is a score rather than a
  match count, because a policy question may share exactly one word and still be the right one.
- `factText(row)` renders a row the way a reader would say it, which is also what the index stores.
- `AnswerContext` now carries the app's `capabilities` (id and title), so a rule can answer questions
  about the assistant itself ("what can you do?") from the same manifest the UI advertises.
- Measured on the site's handbook arena (170 facts, 14 turns nothing was tuned against): the hybrid
  approach moves from 4/14 to 9/14, retrieval alone from 6/14 to 8/14, and the fitted suite stays at
  91/91. On the site's own thread suite the session goes from 21/30 to 28/30 (context 11/17 to 15/17)
  with the routing audit still 48/48.

## 0.7.14 - 2026-11-24

- An MCP-shaped bridge, so the capabilities a page's assistant uses are the same tools a protocol
  client can call: `createToolServer({ capabilities, run })` answers `initialize`, `tools/list` and
  `tools/call` as JSON-RPC 2.0, with one tool per capability, the capability's own JSON Schema, and
  `content` text beside `structuredContent` (a reader gets a sentence, a program gets the value).
- Argument validation happens on the server's side of the wire: a missing required argument, an
  argument the schema never declared, and a value outside an enum are `isError` results that never
  reach the handler, and an unknown tool is a `-32602` error that leaves the channel usable. A caller
  sending `arguments` as a string is refused rather than read as "no arguments".
- `createToolClient(send)` is transport-agnostic: the same client drives the server in-process or over
  a line-based transport, and it rejects a response carrying another call's id.
- `routeRequest(query, { capabilities, prefer })` routes one sentence to one capability, sharing
  `planRequest`'s ranking instead of keeping a second one; `planToolCall` turns a sentence into tool
  calls (one, or one per connected request) and keeps `runnable: false` with its reason when a call
  needs an argument or a page the sentence never gave. A question-shaped sentence prefers the
  capability that answers (`blog.stats`) over the page it is about (`blog.open_archive`).
- Ceiling: a plan whose second step acts on a page the first step opens has no tool-call form a
  client can complete, because the protocol has no way to say "the route landed" (recorded in the
  site's `bench/no-llm/mcp.json` as `l12-route-then-act`).

## 0.7.13 - 2026-11-24

- Accessibility-tree actions without a model: `parseAction(sentence)` reads a verb, a role, a name, an
  ordinal, a scope and a fill value; `resolveAction(request, nodes)` resolves them against a flat
  accessibility tree (role + accessible name + region scopes) and `describeResolution()` says what it
  found in one plain line.
- It refuses rather than guesses. Two controls scoring the same is `ambiguous` with both candidates,
  because a clicked button cannot be unclicked; a hidden control is `hidden` (rendered nowhere) rather than
  absent; a disabled one is `disabled`; and the right name on the wrong role comes back as a `nearMiss`
  ("no button is named Projects; the Projects link has that name") instead of the nearest wrong click.
- A disabled twin does not make a live control ambiguous. The site's SEND button is aria-disabled until
  the input has text, so counting it as a tie would have refused a click that was in fact unambiguous.
- `flattenTree()` walks a nested tree into the flat, document-ordered list, inheriting region scopes and
  hidden state; `ROLE_FAMILY` lets a textbox satisfy "search box" and vice versa, nearest role first.
- Ceilings, both kept scored in the site's suite: `scroll to <section>` matches a nav link with that name
  when the section itself is unnamed, and a role-only "fill the search box" resolves to the page's only
  textbox even when that textbox is a chat input.

## 0.7.12 - 2026-11-24

- `reset()` with no argument starts a new session, so turn numbering restarts. Found by the site's
  preference suite: a recap cited "turn 3" for a preference stated in turn 1 of that session, because the
  counter outlived the history it numbered.

## 0.7.11 - 2026-11-24

- Stated preferences as facts: `createPreferenceMemory({ preferences })` keeps what the visitor asked for
  as a `prefers(<key>, <value>)` assertion, with the utterance that stated it and the order it arrived in.
- The store is the honesty boundary. A host declares the keys and the values it can act on;
  `record()` returns `null` for anything undeclared, so a host that cannot change its tone cannot look as
  though it accepted a tone preference. `get()` reports the declaration's default until something is stated.
- `facts()` returns the latest assertion per key, the shape a rule could join; `stated()` returns the
  history, which is what a recap sentence needs. `reset(id)` returns one key to its default.
- Ceiling: the store holds values, not phrasings. Recognising "keep it short" (and refusing "call me boss")
  stays in the host, so every host writes its own cue table and a phrasing outside it is not claimed.

## 0.7.10 - 2026-11-24

- Working memory with salience: `createWorkingMemory({ subjects, halfLife, minSalience, limit })` and
  `isCoverageQuery(query)`. The engine still keeps one turn (rule, terms, entities); this keeps a session.
- Salience is arithmetic, not a ranking rule: a mention adds 1, every `halfLife` turns (default 2.5) halves
  it, and anything under `minSalience` (0.2) leaves the working set. A repeated subject therefore outlives
  a one-off mention, and a one-off mention is gone about six turns later. `salient()` returns the numbers,
  so a host can show them.
- `context()` hands `analyzeQuestion` the most salient subject and the items the last answer listed, so a
  pointer ("its stack") resolves against the conversation rather than the previous sentence.
- `covered()` answers "what did we cover" from the session, not the working set: it uses a quarter of the
  decay floor so a subject the working set has released still appears in the recap, and it composes the
  sentence in the order things came up while `entities` stays ranked. Mentions are logged apart from the
  verbatim turn window, so recapping after twenty turns does not know only the last twelve.
- `isCoverageQuery` is a closed phrase list ("what did we cover", "where were we", "recap this chat"),
  the same trade the synonym table makes: a phrasing outside it is not recognised and routes elsewhere.
- Ceiling: salience is frequency plus recency, so one mention of the subject the visitor cares about loses
  to a subject named incidentally three times, and the recap is a list of subjects, not a summary of
  claims. Sixteen tests in `test/memory.test.ts`.

## 0.7.9 - 2026-11-24

- Declarative skills: `runSkill(skill, { call })`, `matchSkill`, `selectSkill`, and the `Skill` type
  (trigger, steps, checks, stop condition). A skill is data plus the host's own `compose`/`explain`; the
  runner owns ordering, passing one step's output into the next, and evaluating checks between them.
- Checks are declarative too: `min-items`, `max-items`, `distinct`, `verbatim`, `non-empty`, each read
  from a dot path into the step result and each keeping what it observed, so a failure is a number rather
  than a shrug. `distinct` compares token sets (Jaccard), which is the metric a browser can afford.
- `stop.onCheckFail: 'stop'` is the point of the type: a check guards the step after it, so a page too
  short to summarise in three points stops before the step that would pad to three. The stopped check is
  named in the record, and the remaining steps are reported as `check-failed`.
- `step.input` passes one value from an earlier result as an argument (`{ step, path, as }`); a path that
  resolves to nothing skips the step as `missing-input` instead of calling it with `undefined`.
- A `verbatim` check reads the source from the same step result, which is why a summariser that can be
  checked has to echo the text it read. Eleven tests in `test/skill.test.ts`.

## 0.7.8 - 2026-11-24

- Recovery without a model: `PlannedStep.alternates` records the runner-ups for the same clause (ranked,
  never a route, never one that needs an argument the sentence did not give), and `executePlan` tries them
  when the chosen capability throws or returns nothing. The step record keeps every attempt
  (`attempts: [{ capabilityId, outcome }]`) and the report says which one it tried, so a visitor reads
  "read the newest article failed, so I tried show the newest article card instead." instead of a failure.
- `ExecuteOptions.runAlternate` is the hook that makes recovery real for a host that routes on text:
  re-sending the visitor's words would route to the capability that just failed.
- `AgentRuntime.runCapability(id, args)` runs one capability by id through the same validation,
  confirmation and handler path `send` uses, which is what the site panel passes as `runAlternate`.
- An empty result means a handler produced nothing (`undefined`, `null`, `''`). An empty array is an
  answer, not a failure, so a legitimate "no project lists Cobol" is not replaced by an unrelated result.
- A failed step no longer ends the record: the remaining steps are reported as `previous-failed`, so the
  summary names everything the failure cost. Seven tests in `test/recover.test.ts`.
- Measured on the site's 14-task recovery suite: 8/14 before, 13/14 after. The miss is documented and kept:
  when the only runner-up answers a different act on the same words ("how many posts" for "read the post"),
  the machinery substitutes it unless the host ranks by effect, which no lexical score can do.

## 0.7.7 - 2026-11-24

- `executePlan(plan, { run, currentRoute, maxSteps })`: runs a `planRequest` plan and reports each step.
  The executor owns ordering and preconditions; the host owns effects, so a planned step goes through the
  same path (validation, confirmation, navigation) as a one-step request and cannot reach a control the
  single-call path could not.
- Preconditions are enforced, not assumed: a step with `needs: 'args'` is skipped as `missing-argument`
  rather than run with a guessed enum value, and a step with `needs: 'route'` is skipped as
  `not-on-route` when the page it needs did not open. The first failure stops the plan and is named.
- `PlannedStep` now carries the `route` a step needs, so a host can check the precondition without
  re-reading the manifest.
- The report is one sentence naming what ran and what was refused, so a visitor sees "I did 2 things:
  open the full archive, then copy the email address." instead of a trace they have to interpret.
- Six tests in `test/execute.test.ts`.

## 0.7.6 - 2026-11-24

- `planRequest(query, { capabilities })`: one sentence asking for two things becomes an ordered plan, and
  the plan says what it could not do. The sentence is cut only at a connective whose right side opens with
  its own controller verb, so "show me Hobnob and Readback" stays one request while "open the archive and
  copy his email" becomes two steps. Each clause is routed on its own topic words (the verb is stripped
  before retrieval and used as a ranking signal instead), and each step records the args read off its
  clause plus a `needs` precondition: `route` when the step runs on a page an earlier step opens, `args`
  when a required argument was never stated.
- Declines instead of guessing: `single-request`, `no-second-verb` (the second half named an object, not a
  request) or `unmapped-clause` with the clause that matched nothing. A verb plus an argument it consumes
  outranks a capability that merely mentions the object; a request that names no specific thing prefers a
  route, matching the engine's rule for navigation.
- Eight tests in `test/plan.test.ts`. No model, no planner search: connector split, per-clause BM25, two
  ranking rules.

## 0.7.5 - 2026-11-24

- `summarise()` no longer pads to k. Once at least one sentence is on topic, a candidate with zero
  relevance is not quoted to fill the answer: a summary that adds three off-topic sentences claims
  coverage the corpus does not have. Pass `stopAtZeroRelevance: false` for the older behaviour.

## 0.7.4 - 2026-11-24

- `summarise()` and `splitSentences()` in `core/summarise.ts`: extractive summarisation over any sentence
  set. Picks k sentences by MMR over tf-idf cosine: relevance from `tokenize()` of the question, novelty
  from the distance to what is already picked, and `maxPerSource` (default 1) so one document cannot fill
  the answer. Picks carry `relevance`, `novelty` and `score`, which is what lets a caller show its work and
  a harness score the summary instead of trusting it.
- A question that names nothing in the corpus reports `unguided: true` and still returns diverse sentences
  instead of a relevance ranking of noise.
- No model, no embeddings, no weights: token counts and cosine, over data the app already ships. Six tests,
  including one per failure mode (one document filling the answer, an unguided question, a fragment too
  short to be a sentence).

## 0.7.3 — 2026-11-24

- Answers now reach the app's own vocabulary from the words a visitor actually types. `analyzeQuestion()`
  ships two read-only tables: `LEMMAS` (shipped/shipping -> ship, built -> build, used -> use,
  js -> javascript, ts -> typescript, postgres -> postgresql) and `DOMAIN_SYNONYMS` (toolset -> stack,
  bio/background -> identity, touch -> contact). Entity matching canonicalises both sides, so "does
  anything use js" resolves to the declared `JavaScript` and "what runs on postgres" to `PostgreSQL`.
- A synonym can only map onto an attribute the app already declares, which is why a domain word never
  makes a sentence name an entity it did not name, and why the word still counts as accounted for in
  `mentions`.
- The completed-work phrase that means "stack" grew from `written|built|... in|with` to include
  `shipped`, `powered`, `runs`/`running` with `in|with|on|by`, and it now outranks the container word
  `projects`: "which projects are shipped in typescript" asks about the stack, not the list.
- Keys are the tokens `tokenize()` emits, not the surface words. `tokenize()` stems ("postgres" ->
  `postgr`, "utilises" -> `utilis`), so a table written in surface form would be a second tokenizer,
  which is precisely how constants and queries stopped agreeing in 0.5.1. A test asserts every key
  round-trips through `tokenize()`.

## 0.7.2 — 2026-11-24

- `analyzeQuestion()` fills `slots.combine`: how the two names a question contains are joined.
  `all` for "which projects use python and sqlite" (the projects that have both), `any` for
  "python or rust" (either), `null` for one name or no connective. The operator is read only from
  the words between the two names, nearest first, so a connective elsewhere in the sentence joins
  something else and never turns a single question into a compound one. `nor` is deliberately not
  a cue: "neither A nor B" is an exclusion, not a union, and reading it as `or` would answer both.
- `AnswerContext.combine` carries that slot to answer rules, so a rule that answers over a set can
  pick intersection or union without parsing the question again.
- Constants indexed by `KnowledgeBase` are now also keyed by their joined spelling. `tokenize()`
  splits camel case ("TypeScript" -> `type` + `script`), so a visitor typing `typescript` matched no
  constant at all and "which projects use typescript" answered as if the page listed nothing.
  Entity matching, the exclusion scope and the connective span now go through one helper
  (`subjectAt`) and cannot disagree about whether a name is present.

## 0.7.1 — 2026-11-24

- `analyzeQuestion()` fills `slots.reference`: what a visitor pointed at instead of naming.
  Three cues, resolved against an optional `context` (`{ items, subject }` carried from the last
  turn): an ordinal position in the list the previous answer produced ("the second one", "number
  two", "the last one"), a singular demonstrative standing in for the previous subject ("its
  stack", "who built this"), and a truncated name ("ground" for Groundglass, "the arch" for the
  archive). `slots.subject` falls back to the resolved value when the question named no subject.
- Personal pronouns (`he`, `his`, `they`) are deliberately not resolved to a project: on a personal
  site they refer to the person, and resolving "his stack" to the last project mentioned was the
  first wrong answer this slot produced.
- A relative clause is not a pointer: "the one that uses sqlite" is a description with a filter,
  so it resolves to nothing rather than to whatever the previous turn was about.
- A partial name is only read in a question. "read the newest post" opens with a controller verb,
  so it stays a request for the read action rather than the Readback project that shares its
  prefix.
- Attribute reading learned "written in" / "built with" as a stack cue; the token form scored as
  `writing` and answered the wrong slot.

## 0.7.0 — 2026-11-25

- Renamed from `client-agent` to `boaz`. The name is the record: in Ruth 4 the transaction
  happens at the gate before witnesses, and in Ruth 2:11 the answer comes from what was
  reported, not from a guess.
- Breaking for consumers: the package name, the `bin` (`boaz` instead of `client-agent`), the
  virtual module id (`boaz:manifest`), the dev manifest directory (`.boaz/agent-manifest.json`)
  and the shipped consumer skill (`.agent/skills/boaz-capabilities.md`).
- No API changes. `boaz` resolves the same entry points (`core`, `rules`, `vite`, `react`, `dom`,
  `build`, `probes`, `extract`), and the transcript marker the loop and engines exchange is now
  `[boaz]`.
- `prepack` copies the repo README and LICENSE into the package so the npm page is not blank.

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

- `analyzeQuestion(query, { subjects, attributes })` in `boaz/core`
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

- `boaz/probes` is its own entry point. `boaz/build` re-exports
  `generateProbes`, but importing it in a browser drags in the scanner and with
  it `typescript`; the generator itself is pure and does not need either. The
  shipped probe generator page imports this entry.

## 0.6.7 — 2026-11-23

Coverage before anyone writes a probe by hand.

- `boaz probes --generate --manifest <file>` turns a manifest into
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
  `boaz/build`, so a browser can generate the same file.
- 135 tests.

## 0.6.6 — 2026-11-23

Testing comes with the package.

- `boaz audit --probes <file> --module <file>`: ask every probe, report the engine's own decision
  (the rule that planned a tool call, the capability that ran, the knowledge paragraph quoted), exit 1 on a
  miss. `--json` for CI.
- `boaz bench --probes <file> --module <file> [--samples]`: fidelity, paraphrase similarity with the
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

- **`boaz/extract`**: `createFieldScanner()` reads email / LinkedIn / URL / phone out of text
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

- **Removed** `boaz/webllm`, `boaz/webllm/worker`, `boaz/chrome-ai`, the
  `@mlc-ai/web-llm` peer dependency and the demo worker. No download, no WebGPU requirement, no
  Prompt API. A visitor gets an answer on any browser.
- **New `boaz/rules`**: `KnowledgeBase` holds facts and Datalog rules
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

- **`boaz/chrome-ai`**: an engine over the browser's own on-device model
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
- **`boaz/dom`:** `createDomContextReader({ sections })` turns visible
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

- `boaz/core`: `defineCapability`, registry with late registration, JSON Schema subset validator, BM25 retrieval with route boost, prompt assembly with a token budget, tool-call parser, execution loop (schema retry, confirmation gate, step cap, navigate-then-wait), deterministic lexical engine.
- `boaz/build` + `boaz/cli`: TypeScript-AST extraction of literal declarations, deterministic `agent-manifest.json`, 10 diagnostic codes, `verify` / `manifest` / `codes` / `init --skill`, and a self-check runner over 9 fixtures.
- `boaz/vite`: build plugin emitting the manifest plus a `boaz:manifest` virtual module, with a dev watcher.
- `boaz/react`: `<AgentProvider>`, `useAgentChat`, `useRegisterCapability`.
- `boaz/webllm`: WebGPU worker, engine bridge with progress and lazy load, `createAutoEngine` fallback.
- `apps/demo`: Ledger invoices app, five routes, twelve capabilities, keyword and on-device modes.
