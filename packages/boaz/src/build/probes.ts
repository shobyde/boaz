// Starting probes from a manifest.
//
// A new app has no probe file, so it has no coverage, so nothing catches a
// capability that stops being reachable. The manifest already contains the two
// things a probe needs: the capability's title (what it does) and its keywords
// (how visitors ask for it). This turns those into a probe file a person then
// edits, and names the phrases the manifest itself cannot tell apart.
import type { AgentManifest, ManifestCapability } from '../core/types.js';

export interface ProbeSuggestion {
  question: string;
  /** The capability that should handle it. */
  expect: string;
  /** Group paraphrases of one question for `bench`. */
  intent: string;
}

export interface ProbeCollision {
  /** The phrase as written in the manifest. */
  phrase: string;
  /** A title or a keyword. */
  source: 'title' | 'keyword';
  /** Every capability that claims it, in manifest order. */
  claimants: string[];
}

export interface UncoveredCapability {
  id: string;
  reason: string;
  /** Parameters a probe would have to supply, when that is why there is no probe. */
  needsArgs?: string[];
}

export interface GeneratedProbes {
  questions: ProbeSuggestion[];
  collisions: ProbeCollision[];
  uncovered: UncoveredCapability[];
}

export interface GenerateOptions {
  /** Emit the capability title as a probe. Default true. */
  titles?: boolean;
  /** Emit each keyword as a probe. Default true. */
  keywords?: boolean;
  /** Prefix routes with this verb, so a route probe is a request. Default "take me to". */
  navigationVerb?: string;
}

/** Lowercase, collapse whitespace: two phrases differing only in case are one phrase. */
export function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function asUtterance(text: string, kind: ManifestCapability['kind'], verb: string): string {
  const tidy = normalizePhrase(text).replace(/[.!?,;:]+$/, '');
  if (!tidy) return '';
  // A route is reached by asking to go there, not by naming the destination.
  return kind === 'route' ? `${verb} ${tidy}` : tidy;
}

/**
 * Two capabilities sharing a phrase only collide when they answer the same kind
 * of utterance. A knowledge entry and a route both list "about": the route's
 * probe is "take me to about", the knowledge probe is "about", and the engine
 * decides between question and request before either is considered.
 */
function queryClass(kind: ManifestCapability['kind']): 'question' | 'request' {
  return kind === 'route' || kind === 'action' ? 'request' : 'question';
}

export function generateProbes(manifest: AgentManifest, options: GenerateOptions = {}): GeneratedProbes {
  const withTitles = options.titles ?? true;
  const withKeywords = options.keywords ?? true;
  const verb = options.navigationVerb ?? 'take me to';

  const capabilities = manifest.capabilities;

  // Which capabilities claim each phrase, per query class. Two claimants in the
  // same class make the phrase an expectation nobody can assert: whichever one
  // answered, the probe would be recording a coin flip.
  const keywordClaimants = new Map<string, Map<'question' | 'request', Set<string>>>();
  for (const capability of capabilities) {
    for (const keyword of capability.keywords ?? []) {
      const key = normalizePhrase(keyword);
      if (!key) continue;
      const byClass = keywordClaimants.get(key) ?? new Map<'question' | 'request', Set<string>>();
      const set = byClass.get(queryClass(capability.kind)) ?? new Set<string>();
      set.add(capability.id);
      byClass.set(queryClass(capability.kind), set);
      keywordClaimants.set(key, byClass);
    }
  }
  const rivals = (key: string, kind: ManifestCapability['kind']): string[] => {
    const set = keywordClaimants.get(key)?.get(queryClass(kind)) ?? new Set<string>();
    return [...set];
  };

  const candidates: Array<{ question: string; expect: string; phrase: string; source: 'title' | 'keyword' }> = [];
  const covered = new Set<string>();
  // A capability that needs arguments cannot be probed from a phrase alone: the
  // question names what to open, not which one. Its probe belongs in a hand
  // written file with an `args` object, so it is reported rather than guessed.
  const needsArgs = new Map<string, string[]>();
  const requiredOf = (capability: ManifestCapability): string[] => {
    const required = (capability.paramsSchema as { required?: unknown } | undefined)?.required;
    return Array.isArray(required) ? required.map(String) : [];
  };

  for (const capability of capabilities) {
    const required = requiredOf(capability);
    if (required.length > 0) {
      needsArgs.set(capability.id, required);
      continue;
    }
    if (withTitles && capability.title) {
      const question = asUtterance(capability.title, capability.kind, verb);
      if (question) candidates.push({ question, expect: capability.id, phrase: capability.title, source: 'title' });
    }
    if (withKeywords) {
      for (const keyword of capability.keywords ?? []) {
        const key = normalizePhrase(keyword);
        if (!key || rivals(key, capability.kind).length > 1) continue;
        const question = asUtterance(keyword, capability.kind, verb);
        if (question) candidates.push({ question, expect: capability.id, phrase: keyword, source: 'keyword' });
      }
    }
  }

  // A phrase written twice (two "About Sho" titles) is the same coin flip as a
  // shared keyword, so it is reported rather than emitted.
  const byQuestion = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const list = byQuestion.get(candidate.question) ?? [];
    list.push(candidate);
    byQuestion.set(candidate.question, list);
  }

  const questions: ProbeSuggestion[] = [];
  const collisions: ProbeCollision[] = [];
  for (const [question, group] of byQuestion) {
    const claimants = [...new Set(group.map((item) => item.expect))];
    if (claimants.length > 1) {
      collisions.push({ phrase: group[0]?.phrase ?? question, source: group[0]?.source ?? 'title', claimants });
      continue;
    }
    const owner = claimants[0];
    if (!owner) continue;
    questions.push({ question, expect: owner, intent: owner });
    covered.add(owner);
  }

  for (const [key, byClass] of keywordClaimants) {
    for (const set of byClass.values()) {
      if (set.size < 2) continue;
      const phrase = capabilities
        .flatMap((capability) => capability.keywords ?? [])
        .find((keyword) => normalizePhrase(keyword) === key);
      collisions.push({ phrase: phrase ?? key, source: 'keyword', claimants: [...set] });
    }
  }

  const uncovered: UncoveredCapability[] = [];
  for (const [id, required] of needsArgs) {
    uncovered.push({ id, reason: `needs arguments (${required.join(', ')}), which a phrase alone cannot supply`, needsArgs: required });
  }
  for (const capability of capabilities) {
    if (covered.has(capability.id) || needsArgs.has(capability.id)) continue;
    const claims = [...keywordClaimants.entries()]
      .filter(([, byClass]) => [...byClass.values()].some((ids) => ids.has(capability.id)))
      .map(([key]) => key);
    const reason = claims.length
      ? `every keyword is claimed by another ${queryClass(capability.kind)} capability (${claims.join(', ')})`
      : 'no title and no keywords, so there is nothing to ask';
    uncovered.push({ id: capability.id, reason });
  }

  questions.sort((a, b) => a.expect.localeCompare(b.expect) || a.question.localeCompare(b.question));
  collisions.sort((a, b) => a.phrase.localeCompare(b.phrase));
  uncovered.sort((a, b) => a.id.localeCompare(b.id));
  return { questions, collisions, uncovered };
}

/** The probe file body `probes --generate` writes. */
export function serializeProbes(result: GeneratedProbes): string {
  return `${JSON.stringify({ questions: result.questions }, null, 2)}\n`;
}
