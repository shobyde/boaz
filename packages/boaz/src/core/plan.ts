import type { ManifestCapability } from './types.js';
import { CapabilityIndex, tokenize } from './retriever.js';

/**
 * One sentence can ask for two things. "Open the archive and copy his email"
 * is not one capability call, and no keyword index can return two answers to
 * one query, so the split has to happen before retrieval and be explicit about
 * what it could not place.
 *
 * The split is conservative on purpose. A second clause counts only when it
 * opens with its own verb: "show me Hobnob and Readback" names two objects of
 * one request and stays one request.
 */
export interface PlannedStep {
  /** The clause the visitor wrote, verbatim. */
  text: string;
  /** The verb the clause opened with, canonicalised to a known controller verb. */
  verb: string | null;
  capabilityId: string;
  title: string;
  kind: string;
  /** Arguments read off the clause. Null means a required argument was not stated. */
  args: Record<string, unknown> | null;
  /** What must have happened before this step can run. */
  needs: 'none' | 'route' | 'args';
  /** For a step that acts on a page: the route it needs to be on. */
  route?: string | null;
  /**
   * Runner-ups for the same clause, best first, excluding routes (a wrong page
   * is worse than a refusal). The executor tries these when the chosen
   * capability throws or returns nothing, which is the only recovery a
   * model-free host can make: it knows what else could have served the words.
   */
  alternates?: PlannedAlternate[];
  score: number;
}

export interface PlannedAlternate {
  capabilityId: string;
  title: string;
  kind: string;
  /** Arguments read off the clause for this capability, or null when it needs one it never got. */
  args: Record<string, unknown> | null;
}

export interface PlanOptions {
  capabilities: ManifestCapability[];
  /** App command verbs, on top of the default controller set. */
  controllerVerbs?: string[];
}

export interface RequestPlan {
  steps: PlannedStep[];
  /** Why the sentence is not a plan. Absent when it is one. */
  declined?: 'single-request' | 'no-second-verb' | 'unmapped-clause';
  /** The clause nothing could answer, when declined is 'unmapped-clause'. */
  failed?: string;
  /** A sentence the app can show before it runs the steps. */
  summary: string;
}

const DEFAULT_VERBS =
  'show|open|go|take|read|expand|copy|download|print|visit|browse|scroll|jump|navigate|see|find|list'.split('|');

const LEAD_FILLER = /^(?:please|also|then|and|now|next|after that|afterwards|can you|could you|would you)\b[\s,]*/i;

/** Boundaries that can join two requests. "and" alone usually joins two objects. */
const CONNECTIVE = /\b(and then|then|after that|afterwards|and|plus|also)\b/gi;

function verbSet(extra: string[] = []): Set<string> {
  return new Set([
    ...DEFAULT_VERBS,
    ...extra.map((verb) => verb.replace(/[^a-z]/gi, '').toLowerCase()).filter(Boolean),
  ]);
}

/** The verb a clause opens with, after filler and a leading "me"-style object. */
function leadingVerb(text: string, verbs: Set<string>): string | null {
  let rest = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = rest.replace(LEAD_FILLER, '');
    if (next === rest && i > 0) break;
    rest = next;
  }
  const first = tokenize(rest)[0];
  if (first && verbs.has(first)) return first;
  // "take me to the blog" opens with take; "go to" opens with go. Both are
  // already single tokens, so only the "me ..." forms need looking past.
  const afterMe = /^[a-z]+\s+(?:me|us)\s+/i.exec(rest);
  if (afterMe) {
    const verb = afterMe[0].trim().split(/\s+/)[0].toLowerCase();
    if (verbs.has(verb)) return verb;
  }
  return null;
}

/**
 * Cuts the sentence at every connective whose right side starts with a verb.
 * Positions are kept so each clause keeps the visitor's own words.
 */
function splitClauses(query: string, verbs: Set<string>): string[] {
  const clauses: string[] = [];
  let cursor = 0;
  CONNECTIVE.lastIndex = 0;
  for (let match = CONNECTIVE.exec(query); match; match = CONNECTIVE.exec(query)) {
    const after = query.slice(match.index + match[0].length);
    const trimmed = after.replace(/^[,\s]+/, '');
    if (!trimmed) continue;
    if (!leadingVerb(trimmed, verbs)) continue;
    clauses.push(query.slice(cursor, match.index).trim());
    cursor = match.index + match[0].length;
    // Keep scanning from the same place: the new clause may hold another one.
    CONNECTIVE.lastIndex = cursor;
  }
  clauses.push(query.slice(cursor).trim());
  return clauses.filter(Boolean);
}

/** Reads the enum/email arguments a schema requires out of the clause itself. */
function inferArgs(capability: ManifestCapability, clause: string): Record<string, unknown> | null {
  const schema = capability.paramsSchema;
  const required = schema?.required ?? [];
  if (required.length === 0) return {};
  const tokens = new Set(tokenize(clause));
  const args: Record<string, unknown> = {};
  for (const name of required) {
    const property = schema?.properties?.[name];
    if (!property) return null;
    if (property.enum) {
      const hit = property.enum.find((value) =>
        tokenize(String(value)).some((word) => tokens.has(word)),
      );
      if (hit === undefined) return null;
      args[name] = hit;
      continue;
    }
    if (property.type === 'string') {
      const found = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/.exec(clause)?.[0];
      if (!found) return null;
      args[name] = found;
      continue;
    }
    return null;
  }
  return args;
}

/**
 * The verb is routing information, not a search term. Left in, "show me the
 * skills" scores every capability whose title opens with "show" on the word
 * "show"; the topic words are what decide between them.
 */
function topicOf(clause: string, verb: string | null): string {
  if (!verb) return clause;
  const stripped = clause
    .replace(LEAD_FILLER, '')
    .replace(new RegExp(`\\b${verb}(?:\\s+(?:me|us)\\b)?`, 'i'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || clause;
}

/**
 * A clause can name only the object: "expand hobnob" has no topic word the
 * index knows, because Hobnob is a value in the schema, not a keyword. A
 * capability that enumerates the name is the one that can act on it.
 */
function enumOwners(capabilities: ManifestCapability[], clause: string): ManifestCapability[] {
  const tokens = new Set(tokenize(clause));
  return capabilities.filter((capability) =>
    (capability.paramsSchema?.required ?? []).length > 0 &&
    capability.paramsSchema!.required!.every((name) =>
      capability.paramsSchema?.properties?.[name]?.enum?.some((value) =>
        tokenize(String(value)).some((word) => tokens.has(word)),
      ),
    ),
  );
}

/** Nouns that name a specific thing rather than a place. */
const NAMED_THING = /\b(card|expand|print|download|copy|link|source|repo|site|archive|resume|email|linkedin|pdf|post|posts|article|articles|entry)\b/i;

function verbBoost(capabilityId: string, title: string, verb: string | null): number {
  if (!verb) return 1;
  const [first] = tokenize(title);
  if (first === verb) return 1.5;
  return tokenize(capabilityId).includes(verb) ? 1.2 : 1;
}

interface ClauseContext {
  verbs: Set<string>;
  index: CapabilityIndex;
  capabilities: ManifestCapability[];
  /**
   * What the sentence is: a request names a place or an action, a question
   * names something to answer. A tool surface needs the distinction because a
   * question sent to `tools/call` should not resolve to a route.
   */
  prefer?: 'question' | 'request';
}

interface ClauseSelection {
  verb: string | null;
  capability: ManifestCapability;
  score: number;
  args: Record<string, unknown> | null;
  alternates: PlannedAlternate[];
}

/**
 * Routes one clause to one capability, with its arguments and its runner-ups.
 * A plan is several of these in order; a single request is exactly one, which
 * is why both paths call this instead of keeping two ranking rules.
 */
function selectForClause(clause: string, ctx: ClauseContext): ClauseSelection | { declined: 'unmapped-clause' } {
  const verb = leadingVerb(clause, ctx.verbs);
  const scored = ctx.index
    .search(topicOf(clause, verb), { limit: 5, boost: false })
    .map((entry) => ({ ...entry, score: entry.score * verbBoost(entry.capability.id, entry.capability.title, verb) }))
    .sort((a, b) => b.score - a.score);
  const ranked = scored.filter((entry) => entry.score > 0);
  // The engine's own rule, kept per clause: a request that names no specific
  // thing asks for a place. "Show me the projects" is the page; "expand the
  // card" is the card.
  const place = topicOf(clause, verb);
  // A verb plus an argument it consumes is a complete call, so it decides
  // first: "expand hobnob" is the expand capability even though the object
  // only appears in the card's own keywords. A verb with no argument is just
  // a verb, and the topic words decide.
  const scoredById = new Map(scored.map((entry) => [entry.capability.id, entry.score]));
  const verbAgreed = ctx.capabilities
    .filter(
      (capability) =>
        verbBoost(capability.id, capability.title, verb) > 1 &&
        Object.keys(inferArgs(capability, clause) ?? {}).length > 0,
    )
    .sort((a, b) => (scoredById.get(b.id) ?? 0) - (scoredById.get(a.id) ?? 0))[0];
  const route = NAMED_THING.test(place) ? undefined : ranked.find((entry) => entry.capability.kind === 'route');
  // A request names a place or an action; knowledge paragraphs and queries
  // only answer it when nothing else matched.
  const actionable = ranked.find((entry) => ['route', 'action'].includes(String(entry.capability.kind)));
  // A question asked of a tool surface wants the capability that answers, not
  // the page it is about: "how many posts has he written" is `blog.stats` even
  // though the archive is the loudest keyword match.
  const answerable = ranked.find((entry) => ['query', 'knowledge'].includes(String(entry.capability.kind)));
  const pick: { capability: ManifestCapability; score: number } | undefined = verbAgreed
    ? { capability: verbAgreed, score: scoredById.get(verbAgreed.id) ?? 0 }
    : ctx.prefer === 'question'
      ? answerable ?? route ?? actionable ?? ranked[0]
      : route ?? actionable ?? ranked[0];
  const owner = !pick || pick.score <= 0
    ? enumOwners(ctx.capabilities, clause).sort(
      (a, b) => verbBoost(b.id, b.title, verb) - verbBoost(a.id, a.title, verb),
    )[0]
    : undefined;
  if (!pick && !owner) return { declined: 'unmapped-clause' };
  const capability = owner ?? pick!.capability;
  const score = owner ? 0 : pick!.score;
  const args = inferArgs(capability, clause);
  // Recovery is a ranked fact, not a guess: what else scored on these words,
  // could run without an argument the sentence never gave, and is not a place.
  const alternates: PlannedAlternate[] = String(capability.kind) === 'route'
    ? []
    : ranked
      .filter((entry) => entry.capability.id !== capability.id && String(entry.capability.kind) !== 'route')
      .map((entry) => ({
        capabilityId: entry.capability.id,
        title: entry.capability.title,
        kind: String(entry.capability.kind),
        args: inferArgs(entry.capability, clause),
      }))
      .filter((alternate) => alternate.args !== null)
      .slice(0, 2);
  return { verb, capability, score, args, alternates };
}

export interface RoutedRequest {
  capabilityId: string;
  title: string;
  kind: string;
  args: Record<string, unknown> | null;
  verb: string | null;
  /** Declared the query every capability refused to route, when it did. */
  declined?: 'unmapped-clause';
}

export interface RouteOptions extends PlanOptions {
  /** `question` prefers query/knowledge capabilities; `request` prefers routes/actions. */
  prefer?: 'question' | 'request';
}

/**
 * Routes one request to one capability. `planRequest` answers "what did this
 * sentence ask for"; this answers "which tool serves it", for a host that only
 * has a single call to make. Both share one ranking rule, so a tool surface and
 * a plan cannot disagree about the same words.
 */
export function routeRequest(query: string, options: RouteOptions): RoutedRequest {
  const selection = selectForClause(query, {
    verbs: verbSet(options.controllerVerbs),
    index: new CapabilityIndex(options.capabilities),
    capabilities: options.capabilities,
    ...(options.prefer ? { prefer: options.prefer } : {}),
  });
  if ('declined' in selection) return { capabilityId: '', title: '', kind: '', args: null, verb: null, declined: 'unmapped-clause' };
  return {
    capabilityId: selection.capability.id,
    title: selection.capability.title,
    kind: String(selection.capability.kind),
    args: selection.args,
    verb: selection.verb,
  };
}

/**
 * Plans a request, or declines to. Nothing here reads a model: the sentence is
 * cut at its own connectives, each clause is routed on its own words, and the
 * only cross-clause planning is a precondition check (a page action after a
 * route, or arguments a clause never stated).
 */
export function planRequest(query: string, options: PlanOptions): RequestPlan {
  const verbs = verbSet(options.controllerVerbs);
  const ctx: ClauseContext = {
    verbs,
    index: new CapabilityIndex(options.capabilities),
    capabilities: options.capabilities,
  };
  const clauses = splitClauses(query, verbs);

  if (clauses.length < 2) {
    const connected = /\b(and then|then|after that|afterwards|and|plus|also)\b/i.test(query);
    return { steps: [], declined: connected ? 'no-second-verb' : 'single-request', summary: '' };
  }

  const steps: PlannedStep[] = [];
  for (const clause of clauses) {
    const selection = selectForClause(clause, ctx);
    if ('declined' in selection) {
      return { steps, declined: 'unmapped-clause', failed: clause, summary: '' };
    }
    const { verb, capability, score, args, alternates } = selection;
    const previous = steps[steps.length - 1];
    const needs: PlannedStep['needs'] = !previous
      ? 'none'
      : args === null
        ? 'args'
        : previous.kind === 'route'
          ? 'route'
          : 'none';
    steps.push({
      text: clause,
      verb,
      capabilityId: capability.id,
      title: capability.title,
      kind: String(capability.kind),
      args,
      needs,
      ...(capability.route ? { route: capability.route } : {}),
      ...(alternates.length > 0 && needs !== 'args' ? { alternates } : {}),
      score: Number(score.toFixed(3)),
    });
  }

  const summary = steps
    .map((step, i) => (i === 0 ? step.title : step.title.charAt(0).toLowerCase() + step.title.slice(1)))
    .join(', then ');

  return { steps, summary };
}
