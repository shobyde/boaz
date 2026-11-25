export const BOAZ_SKILL_MD = `---
name: boaz-capabilities
description: Use when adding or changing a route, control, answer rule, or reply copy in an app with the boaz assistant. Declares capabilities, then proves the answers are routed and readable.
---

# boaz: capabilities, answers and proof

This repository ships an in-browser assistant (\`boaz\`). It has no model:
it answers from the build-time capability manifest, from facts and rules your app
declares, and from the page text. It cannot read your source and it cannot see
the DOM. A feature without a capability declaration is invisible to it, and a
question no rule claims gets a keyword guess.

## When this skill applies

Any time you:

- add a route, page, tab, or deep-linked view;
- add or change a modal, wizard, filter, sort, or bulk action;
- rename a user-visible control or change what it does;
- add an answer rule (a sentence computed from app data);
- change any reply copy the assistant says;
- delete a screen, action or rule.

## 1. Declare what exists

Every user-reachable destination gets a \`route\` capability. Every mutating or
stateful control gets an \`action\`. Live state the assistant should read before
acting gets a \`query\`. A fixed paragraph it should quote gets a \`knowledge\`.

Declare it in a \`capabilities.ts\` next to the feature, not in a central file.
Central files rot; co-located ones get updated with the feature.

\`\`\`ts
import { defineCapability } from '@shobyde/boaz/core';

export const openInvoices = defineCapability({
  id: 'billing.open_invoices',
  kind: 'route',
  title: 'Billing & invoices',
  description:
    'Takes the visitor to the billing page where they can change plan, update the payment card, or download past invoices as PDF.',
  keywords: ['invoice', 'receipt', 'payment', 'card', 'subscription', 'plan'],
  route: '/settings/billing',
});
\`\`\`

**Metadata that decides retrieval** (the description is the search text):

- **id**: \`<area>.<verb_or_noun>\`, lowercase, never reused for something else.
  The conversation refers to ids.
- **title**: what a visitor would call it. "Download invoices", not
  \`InvoiceTableToolbar\`.
- **description**: start from the visitor's goal — "Use when the visitor
  wants to…". If it lacks the words a visitor types, the capability is
  unfindable.
- **keywords**: synonyms and plural forms. Cheap; add them.
- **route**: where its UI lives, even for actions.
- **paramsSchema**: strict JSON Schema, \`additionalProperties: false\`, enums over
  free strings.

**Confirmation** (\`requiresConfirmation: true\`) is for deletes, spends, sends,
and anything hard to undo. Not for navigation, filtering, or opening a dialog.

## 2. Decide who answers: capability, rule, or knowledge

The engine tries, in order: an answer rule, then the keyword engine over the
capabilities, then nothing.

| the visitor says | it should be |
| --- | --- |
| "open billing", "filter invoices to overdue" | a \`route\`/\`action\` capability |
| "which invoices are overdue?" | a \`query\` capability, or an answer rule if it joins data |
| "what is your refund policy?" | a \`knowledge\` capability |
| "which projects use Python?" (a join over rows) | an **answer rule** |
| "what does he do?" (a phrasing with no content words) | an **answer rule** with \`match\` |

Rules live in your app, not the library. The library owns retrieval, rule evaluation
and the order of operations; you own the facts.

\`\`\`ts
export const answers = [
  {
    id: 'projects.using',
    title: 'Which projects use a technology',
    keywords: ['which projects use', 'written in', 'uses'],
    goal: 'projects_using(?P)',
    steps: [{ capabilityId: 'projects.list', toFacts: projectFacts }],
    // Needs the visitor to name a technology: no subject, no call.
    explain: ({ terms, solutions }) => \`Matched \${terms[0]} against \${solutions.length} projects\`,
    compose: ({ solutions, terms }) => phraseProjectsUsing(solutions, terms[0]),
  },
];
\`\`\`

Rule options that matter:

- **\`steps\`** run a capability first; the result becomes facts for the goal.
- **\`requiresSubject\`** — a rule that joins \`asked(?T)\` waits until the question
  names a value to look up; a listing rule ("which invoices are overdue") runs
  whenever it matches. Set \`false\` to opt out entirely.
- **\`constants\`** on the engine: values a tool will return, declared up front, so
  "what's built with python?" is recognised before the tool has run.
- **\`match(query)\`** — an explicit trigger for phrasings keyword matching cannot
  see, because they tokenize to nothing ("what does he do?").
- **\`threshold\`** — raise it when two rules share vocabulary.

**Controller verbs are the app's.** A question starting with show / open / go /
take / read / expand / copy / download / print / visit / browse / scroll / jump /
navigate / see is handled by a capability, not by an answer rule. Apps with their
own commands extend the list instead of fighting it:

\`\`\`ts
createRulesEngine({ ..., controllerVerbs: ['filter', 'sort', 'apply', 'clear'] });
\`\`\`

**Enums are literal.** A capability is called with the enum value that appeared in
the question, so "show only the unpaid invoices" cannot fill \`status: overdue\`.
Include the visitor's word in the enum and normalise it in the handler.

## 3. Write the copy like writing

One intent should not have one sentence. Key the construction on the question
form (count-first for "how many", entity-first for "which"), and pick a
realisation from a hash of the question, so paraphrases differ while a repeated
question stays identical — a visitor can quote what they saw.

\`\`\`ts
const pick = (list, key) => list[hash(key) % list.length];

if (/how many|how much/i.test(query)) return pick([\`\${n} projects: \${names}.\`, ...], query);
return pick([\`\${names} — \${n} of them.\`, \`Everything public: \${names}.\`, ...], query);
\`\`\`

Three rules that keep this honest:

- **One intent per rule.** Two rules that read the same tool will fight over any
  shared keyword ("built"), and the loser hijacks the question.
- **Facts first, flourish never.** Every realisation must carry every required
  fact; a stylish wrong answer is a bug.
- **Never invent a claim to sound human.** Extra sentences must come from data
  ("each has engineering notes"), not from adjectives.

## 4. Prove it works

\`verify\` proves the declarations are sound. These two commands prove the
assistant is actually useful, and they are the ones to run before you call a
task done.

**Probe file** — the questions you promise to answer, grouped into intents:

\`\`\`json
{
  "questions": [
    { "question": "which projects use python?", "expect": "projects.using", "intent": "projects.using", "must": ["Readback", "Groundglass"] },
    { "question": "what's built with python?", "expect": "projects.using", "intent": "projects.using", "must": ["Readback", "Groundglass"] },
    { "question": "open the newest article", "expect": "blog.open_newest" },
    { "question": "show the hobnob card", "expect": "projects.card", "args": { "project": "hobnob" } }
  ]
}
\`\`\`

Four paraphrases per intent is enough to expose a template. \`must\` is what a
correct answer contains; \`args\` is what the capability must be called with. Only
intents with a \`must\` list are scored — a route or action has no copy to compare.

**Setup module** — the harness asks *your* engine, not a reimplementation:

\`\`\`js
// agent-setup.mjs
import manifest from './agent-manifest.json' with { type: 'json' };
import { createRulesEngine } from '@shobyde/boaz/rules';

export const capabilities = manifest.capabilities;
export const answers = /* your rules */ [];

// Without this, a rule that reads a tool answers with the tool call, not a sentence.
export const runCapability = async (id, args) =>
  handlers[id] ? handlers[id](args) : {};

export function createEngine() {
  return createRulesEngine({ knowledge, answers, capabilities, constants });
}
\`\`\`

**Run them:**

\`\`\`bash
npx boaz audit --probes agent-probes.json --module agent-setup.mjs
npx boaz bench --probes agent-probes.json --module agent-setup.mjs --samples
\`\`\`

- \`audit\` prints one line per miss — expected id, what actually ran — and exits 1.
  Put it in CI. Add a probe for every capability you declare, in a visitor's words.
  It reports the engine's own plan: a rule that asked for a capability is named,
  a keyword match on the same capability is not. Rules that reply in prose are
  checked by \`bench\` through their \`must\` facts.
- \`bench\` scores the copy per intent: **fidelity** (required facts present),
  **similarity** between paraphrases with the facts masked, **openers**, **spread**,
  **ttr**, **stable** (same question twice). Exit 1 when a fact goes missing or an
  answer wobbles.

Reading the numbers:

| number | means |
| --- | --- |
| similarity 1.00 | every phrasing returned the identical sentence — a template |
| similarity ≈ 0.5 | the wording follows the question |
| similarity < 0.25 | check \`--samples\`: the topics may be drifting |
| fidelity 100% | no paraphrase lost a fact; anything less is a bug, not style |
| stable NO | the same question answered differently — drop the randomness |

Then read the samples. The numbers say the answers stopped repeating; they cannot
say the answers read well.

**No probe file yet?** Generate a starting one from the manifest:

\`\`\`bash
npx boaz probes --generate --manifest dist/agent-manifest.json
\`\`\`

It writes \`probes.generated.json\` with one question per capability title and
keyword, each already expecting the capability it came from, and prints two
lists worth reading: phrases that two capabilities in the same query class both
claim (no probe can assert a coin flip; give one of them a phrase of its own),
and capabilities with no probe (a capability that requires arguments cannot be
probed from a phrase alone, so write that one by hand with \`args\`). Edit the
phrasing to match how your visitors actually talk, then run \`audit\`. A miss on a
generated probe usually means the manifest still claims a phrasing that an
answer rule took over.

## Done means

\`\`\`bash
npx boaz verify
npx boaz audit --probes agent-probes.json --module agent-setup.mjs
npx boaz bench --probes agent-probes.json --module agent-setup.mjs
\`\`\`

All three exit 0. If a new route is intentionally invisible to the assistant, say
so in the pull request instead of leaving an unexplained CAP008.

## Failure modes this catches

| symptom | cause | fix |
| --- | --- | --- |
| "I'm not sure" for a supported thing | no capability description contains the visitor's words | rewrite the description, add keywords |
| a question runs the wrong action | two capabilities share a noun; no verb to separate them | give each its own verb and phrase |
| a bare noun answer ("No stack lists much.") | a rule matched on a quantifier | keep rules to question-shaped phrases |
| every phrasing answers identically | one \`compose\` string per intent | construction on the question, realisation on the hash |
| a phrasing with no content words is ignored | it tokenizes to nothing | \`match(query)\` on the rule |
| a tool is called for a question with nothing to look up | \`requiresSubject\` default | name it \`false\` for listing rules |
`;
