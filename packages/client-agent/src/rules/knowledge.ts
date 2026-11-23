/**
 * A tiny Datalog-style knowledge base: facts are rows, rules are
 * `head(?X) :- body(?X, ?Y), other(?Y)` strings, and the library owns
 * unification. No model, no network, fully synchronous.
 *
 *     const kb = new KnowledgeBase({
 *       facts: [['project', 'readback', 'Readback'], ['uses', 'readback', 'Python 3.10+']],
 *       rules: ['projects_using(?P) :- uses(?P, ?T), asked(?T).'],
 *     });
 *     kb.query('projects_using(?P)', { assume: [['asked', 'Python 3.10+']] });
 */

export type Term = string;
export type FactRow = [string, ...string[]];

export interface Atom {
  rel: string;
  args: Term[];
}

export interface Rule {
  head: Atom;
  body: Atom[];
  /** The source text, kept for proof output and diagnostics. */
  source: string;
}

export type Bindings = Record<string, string>;

export interface ProofStep {
  rule: string;
  bindings: Bindings;
}

export interface Solution {
  bindings: Bindings;
  proof: ProofStep[];
}

export interface KnowledgeBaseOptions {
  facts?: FactRow[];
  rules?: Array<string | Rule>;
}

export interface QueryOptions {
  /** Facts that exist only for this query, such as what the visitor asked. */
  assume?: FactRow[];
  limit?: number;
  /** Guard against recursive rule loops. Default 8. */
  maxDepth?: number;
}

const MAX_RESULTS = 100;

const isVariable = (term: Term): boolean => term.startsWith('?');

function stripDot(text: string): string {
  return text.trim().replace(/\.\s*$/, '');
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function parseAtom(text: string): Atom {
  const clean = stripDot(text);
  const open = clean.indexOf('(');
  if (open === -1) return { rel: clean, args: [] };
  const close = clean.lastIndexOf(')');
  if (close < open) throw new Error(`unbalanced parentheses in atom: ${text}`);
  const rel = clean.slice(0, open).trim();
  const inner = clean.slice(open + 1, close).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rel)) throw new Error(`invalid relation name: ${rel}`);
  return { rel, args: inner.length === 0 ? [] : splitTopLevel(inner) };
}

export function parseRule(text: string): Rule {
  const clean = stripDot(text);
  const separator = clean.indexOf(':-');
  if (separator === -1) throw new Error(`rule needs ":-": ${text}`);
  const head = parseAtom(clean.slice(0, separator));
  const body = splitTopLevel(clean.slice(separator + 2)).map(parseAtom);
  if (body.length === 0) throw new Error(`rule has an empty body: ${text}`);
  return { head, body, source: `${formatAtom(head)} :- ${body.map(formatAtom).join(', ')}` };
}

export function formatAtom(atom: Atom): string {
  return `${atom.rel}(${atom.args.join(', ')})`.replace('()', '');
}

/** Renames a rule's variables so recursive applications cannot collide. */
function renameRule(rule: Rule, tag: number): Rule {
  const map = new Map<string, string>();
  const rename = (term: Term): Term => {
    if (!isVariable(term)) return term;
    if (!map.has(term)) map.set(term, `?${tag}_${term.slice(1)}`);
    return map.get(term) as string;
  };
  const atom = (a: Atom): Atom => ({ rel: a.rel, args: a.args.map(rename) });
  return { head: atom(rule.head), body: rule.body.map(atom), source: rule.source };
}

function unify(pattern: Term[], row: string[], env: Bindings): Bindings | null {
  if (pattern.length !== row.length) return null;
  const next: Bindings = { ...env };
  for (let i = 0; i < pattern.length; i += 1) {
    const term = pattern[i];
    const value = row[i];
    if (isVariable(term)) {
      const bound = next[term];
      if (bound !== undefined && bound !== value) return null;
      next[term] = value;
    } else if (term !== value) {
      return null;
    }
  }
  return next;
}

function visibleBindings(env: Bindings): Bindings {
  const out: Bindings = {};
  for (const [key, value] of Object.entries(env)) {
    // Rule-local renamed variables are noise in a proof; only report ?P style
    // names the caller asked for.
    if (/^\?[A-Z][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

export class KnowledgeBase {
  readonly rules: Rule[];
  private readonly rels = new Map<string, string[][]>();
  private readonly vocabulary = new Map<string, string[]>();

  constructor(options: KnowledgeBaseOptions = {}) {
    this.rules = (options.rules ?? []).map((rule) => (typeof rule === 'string' ? parseRule(rule) : rule));
    for (const fact of options.facts ?? []) this.add(fact);
  }

  /** Adds one row: ['uses', 'readback', 'Python 3.10+']. */
  add(fact: FactRow): void {
    const [rel, ...args] = fact;
    if (typeof rel !== 'string' || !rel) throw new Error('a fact needs a relation name');
    const rows = this.rels.get(rel) ?? [];
    const key = args.join('\u0000');
    if (!rows.some((row) => row.join('\u0000') === key)) rows.push(args);
    this.rels.set(rel, rows);
    for (const arg of args) this.indexConstant(arg);
  }

  addAll(facts: FactRow[]): void {
    for (const fact of facts) this.add(fact);
  }

  private indexConstant(constant: string): void {
    const words = constant
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => word.length > 1 && !/^\d+$/.test(word));
    for (const word of words) {
      const list = this.vocabulary.get(word) ?? [];
      if (!list.includes(constant)) list.push(constant);
      this.vocabulary.set(word, list);
    }
  }

  /** Canonical constants whose words include the given token. */
  canonicalFor(token: string): string[] {
    return this.vocabulary.get(token.toLowerCase()) ?? [];
  }

  /** Every declared row, in declaration order. */
  facts(): FactRow[] {
    const rows: FactRow[] = [];
    for (const [rel, values] of this.rels) for (const args of values) rows.push([rel, ...args]);
    return rows;
  }

  /** Every constant the caller has declared, in declaration order. */
  constants(): string[] {
    const all: string[] = [];
    for (const rows of this.rels.values()) for (const row of rows) all.push(...row);
    return [...new Set(all)];
  }

  private rowsFor(rel: string, assume: string[][]): string[][] {
    const base = this.rels.get(rel) ?? [];
    const extra = assume.filter((row) => row[0] === rel).map((row) => row.slice(1));
    return extra.length === 0 ? base : [...base, ...extra];
  }

  query(goal: string | Atom, options: QueryOptions = {}): Solution[] {
    const atom = typeof goal === 'string' ? parseAtom(goal) : goal;
    const assume = (options.assume ?? []).map((fact) => [fact[0], ...fact.slice(1)]);
    const maxDepth = options.maxDepth ?? 8;
    const limit = options.limit ?? MAX_RESULTS;
    const out: Solution[] = [];
    const seen = new Set<string>();

    for (const found of this.prove(atom, {}, assume, 0, maxDepth)) {
      const key = JSON.stringify(found.bindings);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(found);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** First match, or undefined. */
  first(goal: string | Atom, options: QueryOptions = {}): Solution | undefined {
    return this.query(goal, { ...options, limit: 1 })[0];
  }

  private *prove(
    atom: Atom,
    env: Bindings,
    assume: string[][],
    depth: number,
    maxDepth: number,
  ): Generator<Solution> {
    if (depth > maxDepth) return;

    for (const row of this.rowsFor(atom.rel, assume)) {
      const bound = unify(atom.args, row, env);
      if (bound) yield { bindings: bound, proof: [] };
    }

    for (const rule of this.rules) {
      if (rule.head.rel !== atom.rel) continue;
      const renamed = renameRule(rule, depth + 1);
      for (const bodySolution of this.proveBody(renamed.body, env, assume, depth + 1, maxDepth)) {
        // The head's variables must agree with the goal; a constant head term
        // (rare but legal) filters too.
        const headRow: string[] = renamed.head.args.map((term) =>
          isVariable(term) ? (bodySolution.bindings[term] ?? '\u0000unbound') : term,
        );
        const bound = unify(atom.args, headRow, bodySolution.bindings);
        if (!bound) continue;
        yield {
          bindings: bound,
          proof: [
            { rule: rule.source, bindings: visibleBindings(bodySolution.bindings) },
            ...bodySolution.proof,
          ],
        };
      }
    }
  }

  private *proveBody(
    body: Atom[],
    env: Bindings,
    assume: string[][],
    depth: number,
    maxDepth: number,
  ): Generator<Solution> {
    if (body.length === 0) {
      yield { bindings: env, proof: [] };
      return;
    }
    const [head, ...rest] = body;
    for (const solution of this.prove(head, env, assume, depth, maxDepth)) {
      for (const tail of this.proveBody(rest, solution.bindings, assume, depth, maxDepth)) {
        yield { bindings: tail.bindings, proof: [...solution.proof, ...tail.proof] };
      }
    }
  }
}

/** Convenience: `fact('uses', 'readback', 'Python 3.10+')`. */
export function fact(rel: string, ...args: string[]): FactRow {
  return [rel, ...args];
}
