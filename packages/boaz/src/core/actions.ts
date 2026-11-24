/* ============================================================
   Actions on an accessibility tree without a model.

   Everything else in this package answers a question. This is the
   other half of an agent loop: doing something. The surface a
   browser hands you is the accessibility tree, which is already a
   typed, named, ordered list of controls — a schema, not a picture.

   So "click the send button" does not need a vision model, and does
   not need a model at all: it needs the role the visitor named, the
   name the control already carries, and a tie-break rule for the two
   buttons that share a name.

   The resolver refuses rather than guesses. Two controls scoring the
   same is reported as `ambiguous` with both candidates, because a
   clicked button cannot be unclicked; a hidden control is reported as
   `hidden` rather than dismissed as absent, since the difference
   between "not on this page" and "on this page but not rendered" is
   the whole diagnosis.
   ============================================================ */

export type ActionVerb = 'click' | 'fill' | 'scroll' | 'focus';

export interface ActionNode {
  role: string;
  /** Accessible name: aria-label, aria-labelledby text, or the text content. */
  name?: string;
  /** Region/landmark labels this node sits inside, outermost first. */
  scopes?: string[];
  /** aria-hidden, display:none, or inside either. Excluded, then reported. */
  hidden?: boolean;
  disabled?: boolean;
  /** Current value of an input, when the host supplies it. */
  value?: string;
  children?: ActionNode[];
}

export interface ActionRequest {
  verb: ActionVerb;
  /** Canonical ARIA role the verb applies to, when the visitor named one. */
  role?: string;
  /** Accessible name as the visitor typed it, normalised later. */
  name?: string;
  /** 1-based among equally scored candidates; -1 means the last one. */
  ordinal?: number;
  /** Region label the visitor restricted the search to ("the chat panel"). */
  scope?: string;
  /** The target phrase as typed, used as weak evidence when it names no control. */
  hint?: string;
  /** Value to fill, for `fill`. */
  text?: string;
}

export type ActionReason =
  | 'resolved'
  | 'no-verb'
  | 'no-target'
  | 'ambiguous'
  | 'hidden'
  | 'disabled'
  | 'role-mismatch'
  | 'name-mismatch';

export interface ActionCandidate {
  node: ActionNode;
  index: number;
  score: number;
}

export interface ActionResolution {
  ok: boolean;
  request?: ActionRequest;
  node?: ActionNode;
  index?: number;
  score: number;
  reason: ActionReason;
  /** The right name on a role the verb does not act on, when there is one. */
  nearMiss?: ActionNode;
  /** Everything that scored above zero, best first, for the host to name. */
  considered: ActionCandidate[];
}

const VERBS: Array<[RegExp, ActionVerb]> = [
  [/^(?:please\s+|can you\s+|could you\s+|then\s+|and\s+)?(?:click|press|tap|push|hit|activate)\b/, 'click'],
  [/^(?:please\s+|can you\s+|could you\s+|then\s+|and\s+)?(?:fill|type|enter|write|put)\b/, 'fill'],
  [/^(?:please\s+|can you\s+|could you\s+|then\s+|and\s+)?(?:scroll|jump|go)\b/, 'scroll'],
  [/^(?:please\s+|can you\s+|could you\s+|then\s+|and\s+)?(?:focus|highlight|select)\b/, 'focus'],
];

/** The noun a visitor uses for a role. Both directions are closed lists. */
const ROLE_NOUNS: Array<[RegExp, string]> = [
  [/\b(?:search\s+box|search\s+field)\b/, 'searchbox'],
  [/\b(?:text\s*box|text\s*field|input|field|form\s+field|box)\b/, 'textbox'],
  [/\b(?:button|btn)\b/, 'button'],
  [/\b(?:link|hyperlink)\b/, 'link'],
  [/\b(?:checkbox|tick\s*box)\b/, 'checkbox'],
  [/\b(?:radio\s+button|radio)\b/, 'radio'],
  [/\b(?:tab)\b/, 'tab'],
  [/\b(?:menu\s+item|menuitem)\b/, 'menuitem'],
  [/\b(?:heading|header\s+text|section\s+title)\b/, 'heading'],
  [/\b(?:switch|toggle)\b/, 'switch'],
  [/\b(?:image|picture|thumbnail)\b/, 'img'],
];

const VERB_ROLES: Record<ActionVerb, string[]> = {
  click: ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'],
  fill: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  scroll: [],
  focus: [],
};

/**
 * Roles a visitor's noun may legitimately mean, nearest first. Order matters:
 * `searchbox` is a textbox in ARIA and an input[type=search] is a searchbox in
 * Chromium, so "the search box" has to accept both, with the nearer role winning
 * a narrow contest. Two controls of the same role still tie and refuse.
 */
const ROLE_FAMILY: Record<string, string[]> = {
  textbox: ['textbox', 'searchbox', 'combobox'],
  searchbox: ['searchbox', 'textbox'],
  combobox: ['combobox', 'textbox'],
  button: ['button'],
  link: ['link'],
};

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  last: -1,
};

const ARTICLES = /^(?:the|a|an|that|this|its|his|her|their)\s+/;

/** Case, punctuation, articles and spacing: the only free variation in a name. */
export function normaliseName(input: string): string {
  return String(input)
    .replace(/&/g, ' and ')
    .replace(/[‘’“”"']/g, '')
    .replace(/[^A-Za-z0-9#+/. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(ARTICLES, '');
}

function tokensOf(input: string): string[] {
  return normaliseName(input)
    .split(' ')
    .filter((t) => t.length > 0 && !['the', 'a', 'an', 'of', 'to', 'in', 'on'].includes(t));
}

/** Words that describe the control rather than name it. */
const ROLE_WORDS = new Set([
  'button', 'btn', 'link', 'field', 'input', 'textbox', 'text', 'box', 'checkbox',
  'radio', 'tab', 'menuitem', 'menu', 'item', 'heading', 'switch', 'toggle', 'image',
  'picture', 'thumbnail', 'search', 'form',
]);

function stripRoleWords(phrase: string): string {
  const kept = phrase.split(' ').filter((w) => !ROLE_WORDS.has(w));
  return kept.join(' ').trim();
}

/**
 * Read one sentence into an action request, or `null` when the sentence is not
 * an action. Roles, ordinals and scopes come from closed tables; the name is
 * whatever is left after those are removed, so a control whose name is new to
 * the package still resolves.
 */
export function parseAction(query: string): ActionRequest | null {
  const text = String(query).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let verb: ActionVerb | undefined;
  let rest = '';
  for (const [pattern, kind] of VERBS) {
    const hit = pattern.exec(text.toLowerCase());
    if (hit) {
      verb = kind;
      rest = text.slice(hit[0].length).trim();
      break;
    }
  }
  if (!verb || !rest) return null;

  let scope: string | undefined;
  const scopeHit = /\b(?:in|inside|within|on)\s+(?:the\s+)?([a-z0-9 ]+?)\s+(?:panel|menu|nav|navigation|header|footer|card|dialog|sidebar|section|bar)\b/i.exec(
    rest,
  );
  if (scopeHit) {
    scope = scopeHit[1].trim();
    rest = `${rest.slice(0, scopeHit.index)} ${rest.slice(scopeHit.index + scopeHit[0].length)}`.trim();
  }

  let fillText: string | undefined;
  if (verb === 'fill') {
    const withHit = /\bwith\b/i.exec(rest);
    const intoHit = /\b(?:into|in|to)\b/i.exec(rest);
    if (withHit) {
      // "fill the email field with sho@example.com": target, then value.
      fillText = unquote(rest.slice(withHit.index + withHit[0].length).trim());
      rest = rest.slice(0, withHit.index).trim();
    } else if (intoHit) {
      // "type sho@example.com into the email field": value, then target.
      fillText = unquote(rest.slice(0, intoHit.index).trim());
      rest = rest.slice(intoHit.index + intoHit[0].length).trim();
    }
  }

  if (!rest) return null;

  let role: string | undefined;
  const lower = rest.toLowerCase();
  for (const [pattern, canonical] of ROLE_NOUNS) {
    if (pattern.test(lower)) {
      role = canonical;
      break;
    }
  }

  let ordinal: number | undefined;
  const ordinalHit = /\b(first|second|third|fourth|fifth|last)\b/.exec(lower);
  if (ordinalHit) ordinal = ORDINALS[ordinalHit[1]];

  let namePart = lower
    .replace(/\b(?:first|second|third|fourth|fifth|last)\b/, ' ')
    .replace(/\b(?:button|btn|link|hyperlink|field|input|text\s*box|textbox|checkbox|tick\s*box|radio|tab|menu\s+item|heading|switch|toggle|image|picture|thumbnail|search\s+box)\b/g, ' ')
    .replace(/\b(?:on the page|in the page|on this page)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  namePart = stripRoleWords(namePart);
  const name = unquote(namePart.replace(/^(?:the|a|an)\b\s*/, '').trim());
  // A target named only by its role ("fill the search box") is still a target.
  if (!name && !role) return null;

  const request: ActionRequest = { verb };
  const hint = rest.replace(/^(?:the|a|an)\s+/i, '').trim();
  if (name) request.name = name;
  else if (hint) request.hint = hint;
  if (role) request.role = role;
  if (ordinal !== undefined) request.ordinal = ordinal;
  if (scope) request.scope = scope;
  if (fillText !== undefined) request.text = fillText;
  return request;
}

function unquote(input: string): string {
  return input.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

/** Walk a nested tree into the flat, document-ordered list the resolver wants. */
export function flattenTree(nodes: ActionNode[], scopes: string[] = [], hidden = false): ActionNode[] {
  const out: ActionNode[] = [];
  for (const node of nodes) {
    const ownScope = node.scopes ?? [];
    const nodeHidden = hidden || node.hidden === true;
    out.push({ ...node, scopes: [...scopes, ...ownScope], hidden: nodeHidden, children: undefined });
    if (node.children?.length) {
      out.push(...flattenTree(node.children, [...scopes, ...ownScope, ...(node.name ? [node.name] : [])], nodeHidden));
    }
  }
  return out;
}

interface Scored {
  node: ActionNode;
  index: number;
  score: number;
  exactName: boolean;
}

/**
 * Resolve a request (or a sentence) against the tree. Refusals carry the reason
 * and the candidates, so a host can say "two buttons are called Send" instead of
 * clicking one and hoping.
 */
export function resolveAction(
  input: ActionRequest | string,
  nodes: ActionNode[],
): ActionResolution {
  const request = typeof input === 'string' ? parseAction(input) : input;
  if (!request) {
    return { ok: false, score: 0, reason: 'no-verb', considered: [] };
  }

  const wanted = normaliseName(request.name ?? '');
  const wantedTokens = new Set(tokensOf(request.name ?? ''));
  const roleAllowed = request.role ? ROLE_FAMILY[request.role] ?? [request.role] : VERB_ROLES[request.verb];
  const seen: Scored[] = [];
  let roleSeen = 0;
  let hiddenMatches = 0;
  let disabledMatch: Scored | undefined;
  let offRoleMatch: ActionNode | undefined;

  nodes.forEach((node, index) => {
    if (node.hidden) {
      if (wanted && normaliseName(node.name ?? '') === wanted) hiddenMatches += 1;
      return;
    }
    // The right name on the wrong role is worth reporting, not clicking.
    if (!offRoleMatch && wanted && normaliseName(node.name ?? '') === wanted && !roleAllowed.includes(node.role)) {
      offRoleMatch = node;
    }
    if (roleAllowed.length > 0 && !roleAllowed.includes(node.role)) return;
    roleSeen += 1;
    // A role the noun names directly beats a role from the same family.
    const roleRank = Math.max(0, roleAllowed.indexOf(node.role));

    const nodeName = normaliseName(node.name ?? '');
    if (!wanted) {
      // Role-only request ("fill the search box"): every control of that role is a candidate,
      // and the phrase's own words are weak evidence for which one.
      let score = 0.45 - 0.05 * roleRank;
      if (request.hint) {
        const hintTokens = tokensOf(request.hint);
        const nodeTokens = tokensOf(node.name ?? '');
        const covered = hintTokens.filter((t) => nodeTokens.includes(t)).length;
        if (hintTokens.length > 0 && covered > 0) score += 0.15 * (covered / hintTokens.length);
      }
      if (request.scope) {
        const scope = normaliseName(request.scope);
        const inScope = (node.scopes ?? []).some((s) => normaliseName(s).includes(scope));
        score += inScope ? 0.2 : -0.1;
      }
      if (!node.disabled) seen.push({ node, index, score: Math.round(score * 1000) / 1000, exactName: false });
      else disabledMatch = { node, index, score, exactName: false };
      return;
    }
    let nameScore = 0;
    let exactName = false;
    if (nodeName === wanted) {
      nameScore = 0.6;
      exactName = true;
    } else {
      const nodeTokens = tokensOf(node.name ?? '');
      const covered = [...wantedTokens].filter((t) => nodeTokens.includes(t)).length;
      if (wantedTokens.size > 0 && covered === wantedTokens.size) {
        // Same words, different order or extra words the visitor did not say.
        nameScore = nodeTokens.length === wantedTokens.size ? 0.55 : 0.45;
      } else if (covered > 0) {
        nameScore = 0.3 * (covered / wantedTokens.size);
      }
    }
    if (nameScore === 0) return;

    let score = nameScore;
    if (request.role) score += 0.25;
    if (request.scope) {
      const scope = normaliseName(request.scope);
      const inScope = (node.scopes ?? []).some((s) => normaliseName(s).includes(scope));
      if (inScope) score += 0.2;
      else score -= 0.1;
    }
    const scored = { node, index, score: Math.round(score * 1000) / 1000, exactName };
    // A control that cannot be used is not a tie: it cannot be clicked either.
    if (node.disabled) disabledMatch = scored;
    else seen.push(scored);
  });

  seen.sort((a, b) => b.score - a.score || a.index - b.index);
  const considered = seen.slice(0, 5).map(({ node, index, score }) => ({ node, index, score }));

  if (seen.length === 0) {
    if (hiddenMatches > 0) return { ok: false, request, score: 0, reason: 'hidden', considered: [] };
    if (disabledMatch) {
      return { ok: false, request, node: disabledMatch.node, index: disabledMatch.index, score: disabledMatch.score, reason: 'disabled', considered: [] };
    }
    if (roleSeen === 0 && request.role) {
      return { ok: false, request, score: 0, reason: 'role-mismatch', considered: [], ...(offRoleMatch ? { nearMiss: offRoleMatch } : {}) };
    }
    return { ok: false, request, score: 0, reason: 'name-mismatch', considered: [], ...(offRoleMatch ? { nearMiss: offRoleMatch } : {}) };
  }

  const best = seen[0];
  const ties = seen.filter((s) => Math.abs(s.score - best.score) < 0.001);

  if (ties.length > 1 && request.ordinal === undefined) {
    return { ok: false, request, score: best.score, reason: 'ambiguous', considered };
  }

  let chosen = best;
  if (request.ordinal !== undefined) {
    const pick = request.ordinal < 0 ? ties[ties.length - 1] : ties[request.ordinal - 1];
    if (!pick) {
      return { ok: false, request, score: best.score, reason: 'ambiguous', considered };
    }
    chosen = pick;
  }

  if (chosen.node.disabled) {
    return { ok: false, request, node: chosen.node, index: chosen.index, score: chosen.score, reason: 'disabled', considered };
  }

  return {
    ok: true,
    request,
    node: chosen.node,
    index: chosen.index,
    score: chosen.score,
    reason: 'resolved',
    considered,
  };
}

/** The sentence a host prints before it acts. One line, no jargon. */
export function describeResolution(resolution: ActionResolution): string {
  const { request } = resolution;
  const target = [request?.role, request?.name && `"${request.name}"`].filter(Boolean).join(' ');
  switch (resolution.reason) {
    case 'resolved':
      return `Found ${target || 'the control'}${request?.scope ? ` in the ${request.scope}` : ''}, ${resolution.node?.role} at position ${(resolution.index ?? 0) + 1}.`;
    case 'ambiguous':
      return `${resolution.considered.length} controls match ${target}: ${resolution.considered
        .map((c) => `"${c.node.name ?? c.node.role}"`)
        .slice(0, 3)
        .join(', ')}. Nothing was clicked.`;
    case 'hidden':
      return `${target} exists but is not rendered, so nothing was clicked.`;
    case 'disabled':
      return `${target} is disabled, so nothing was clicked.`;
    case 'role-mismatch':
      return [
        `This page has no ${request?.role ?? 'control'} to ${request?.verb ?? 'use'}.`,
        resolution.nearMiss ? `The ${resolution.nearMiss.name} ${resolution.nearMiss.role} has that name.` : '',
      ].filter(Boolean).join(' ');
    case 'name-mismatch':
      return [
        `No ${request?.role ?? 'control'} is named "${request?.name ?? ''}".`,
        resolution.nearMiss ? `The ${resolution.nearMiss.name} ${resolution.nearMiss.role} has that name.` : '',
      ].filter(Boolean).join(' ');
    default:
      return 'That sentence is not an action.';
  }
}
