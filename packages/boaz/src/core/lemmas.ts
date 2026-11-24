/**
 * A bundled vocabulary, not a model.
 *
 * A visitor does not use the app's words. A capability is titled "project
 * stack" and the visitor types "toolset"; the page declares "JavaScript" and
 * they type "js"; the rule says "written" and they say "shipped". Every one of
 * those is a lookup, not an inference, so it belongs in a table that ships with
 * the library and can be read, tested and argued with.
 *
 * Keys are the tokens `tokenize()` emits, not the surface words: tokenize stems
 * plurals and splits camel case, so "PostgreSQL" is `postgre` + `sql` and
 * "postgres" is `postgr`. Writing the table in surface form would make it a
 * second tokenizer, which is exactly the bug that cost 0.5.1 (constants matched
 * through a different split than the retriever used). `test/question.test.ts`
 * asserts every key round-trips through `tokenize()` so a surface word cannot
 * be mistaken for a token.
 *
 * `LEMMAS` is generic English morphology plus technology aliases; it applies to
 * entity matching and attribute lookup alike. `DOMAIN_SYNONYMS` only maps words
 * onto an attribute name the app already declares, so it can never make a
 * sentence name an entity it did not name.
 */
export const LEMMAS: Record<string, string> = {
  // Inflection the stemmer does not fold. `shipped` stays `shipped`, `built`
  // stays `built`, so a capability keyworded "ship" or "build" misses the past
  // tense, which is the tense visitors use about finished work.
  shipped: 'ship',
  shipping: 'ship',
  built: 'build',
  building: 'build',
  used: 'use',
  using: 'use',
  // `tokenize()` reads "writes" as `writ` (it strips a trailing "es" from any
  // word longer than four letters), so both spellings have to be listed.
  writ: 'write',
  wrote: 'write',
  written: 'write',
  writing: 'write',
  made: 'make',
  making: 'make',
  leverage: 'use',
  leverag: 'use',
  leveraged: 'use',
  utilise: 'use',
  utilis: 'use',
  utilised: 'use',
  utilize: 'use',
  utiliz: 'use',
  utilized: 'use',
  // Abbreviations a developer types about their own stack. Kept short and
  // word-level: "chart" is not "ts", "json" is not "js".
  js: 'javascript',
  ts: 'typescript',
  postgr: 'postgresql',
  postgre: 'postgresql',
  k8s: 'kubernetes',
  nodejs: 'node',
};

/**
 * Words that mean an attribute the app already declares. The value must be a
 * name in the app's attribute table (stack, writing, contact, identity, ...);
 * anything else is a typo that would silently drop the word from `mentions`.
 */
export const DOMAIN_SYNONYMS: Record<string, string> = {
  toolset: 'stack',
  toolchain: 'stack',
  tooling: 'stack',
  bio: 'identity',
  background: 'identity',
  experience: 'identity',
  touch: 'contact',
  dm: 'contact',
  portfolio: 'projects',
  essay: 'writing',
};

/** The canonical token for a query token, or the token unchanged. */
export function canonicalTerm(token: string): string {
  return LEMMAS[token] ?? token;
}
