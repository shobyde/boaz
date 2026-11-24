/* ============================================================
   Declarative skills without a model.

   A plan (0.7.6) is split off one sentence and runs once. A skill is
   the thing a host needs when the task has a shape the visitor did not
   spell out: a trigger, two or more capability calls where a later call
   consumes an earlier one's output, checks between them, and a stop
   condition that fires before the skill invents work it cannot do.

   Everything here is data plus a runner. There is no code in a skill
   beyond the host's own compose/explain functions, so what a skill will
   do can be read off the file and audited the way a capability is.

   The interesting property is the stop condition: "summarise this page
   in three points" on a page with two sentences must say it cannot,
   rather than pad. That is a check, and it runs before the step that
   would pad.
   ============================================================ */

import { tokenize } from './retriever.js';

export interface SkillStep {
  /** Used by checks and by later steps that read this result. */
  id: string;
  capabilityId: string;
  title?: string;
  /** Arguments the skill itself supplies (never read from the question). */
  args?: Record<string, unknown>;
  /**
   * One argument taken from an earlier step's result: `{ step: 'sections',
   * path: 'text', as: 'text' }`. The runner passes the resolved value as an
   * argument, so a step can consume what the previous step produced.
   */
  input?: { step: string; path: string; as: string };
}

export type SkillCheckKind = 'min-items' | 'max-items' | 'distinct' | 'verbatim' | 'non-empty';

export interface SkillCheck {
  id: string;
  /** The step whose result this check reads. */
  after: string;
  kind: SkillCheckKind;
  /** Dot path into that result. `.length` works because arrays have one. */
  path: string;
  /** Threshold for min-items / max-items / distinct (max similarity). */
  value?: number;
  /** Field of each item for distinct and verbatim. Default `text`. */
  field?: string;
  /** For verbatim: the path holding the source text the item must appear in. */
  against?: string;
  /** One plain sentence: what the check saw, shown when it passes or fails. */
  message: string;
}

export interface Skill {
  id: string;
  title: string;
  trigger: {
    /** Phrases a visitor would type. Matched whole, case and punctuation folded. */
    phrases: string[];
    /** Optional extra condition, e.g. a shape the phrases cannot express. */
    require?: RegExp;
  };
  steps: SkillStep[];
  checks: SkillCheck[];
  stop: {
    /** What to do when a check fails. Default `stop`. */
    onCheckFail?: 'stop' | 'continue';
    /** Cap on executed steps. Default 4. */
    maxSteps?: number;
  };
  /** The host's own wording. The library decides the shape, not the prose. */
  compose?: (run: SkillRun) => string;
  /** The plain-English "how" line under an answer. */
  explain?: (run: SkillRun) => string;
}

export interface SkillStepRecord {
  id: string;
  capabilityId: string;
  title: string;
  status: 'ran' | 'skipped' | 'failed';
  reason?: 'check-failed' | 'previous-failed' | 'step-limit' | 'missing-input';
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface SkillCheckRecord extends SkillCheck {
  ok: boolean;
  /** What the check actually read, so a failure is inspectable. */
  observed: string;
}

export interface SkillRun {
  skillId: string;
  title: string;
  steps: SkillStepRecord[];
  checks: SkillCheckRecord[];
  /** True when every step ran and every check passed. */
  ok: boolean;
  /** The check that stopped the run, if one did. */
  stopped?: { check: string; message: string };
  failedAt?: string;
}

export interface RunSkillOptions {
  /** Runs one capability by id. The host's ordinary path, never a second one. */
  call: (capabilityId: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  maxSteps?: number;
}

function normalise(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The skill whose trigger phrase the question contains. Longest phrase wins, so
 * "summarise this page in three points" beats a skill triggered by "summarise".
 * A phrase has to appear as whole words, or "page" triggers on "pager".
 */
export function matchSkill(skill: Skill, query: string): string | null {
  if (skill.trigger.require && !skill.trigger.require.test(query)) return null;
  const haystack = ` ${normalise(query)} `;
  let best: string | null = null;
  for (const phrase of skill.trigger.phrases) {
    const needle = ` ${normalise(phrase)} `;
    if (!needle.trim()) continue;
    if (haystack.includes(needle) && (!best || phrase.length > best.length)) best = phrase;
  }
  return best;
}

export function selectSkill(skills: Skill[], query: string): Skill | null {
  let winner: { skill: Skill; phrase: string } | null = null;
  for (const skill of skills) {
    const phrase = matchSkill(skill, query);
    if (!phrase) continue;
    if (!winner || phrase.length > winner.phrase.length) winner = { skill, phrase };
  }
  return winner?.skill ?? null;
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cursor: unknown = value;
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function items(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Token-set Jaccard. Two items at or above the threshold are the same point. */
function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function evaluate(check: SkillCheck, result: unknown): { ok: boolean; observed: string } {
  const at = getPath(result, check.path);
  const field = check.field ?? 'text';
  switch (check.kind) {
    case 'min-items': {
      const count = Array.isArray(at) ? at.length : typeof at === 'number' ? at : 0;
      return { ok: count >= (check.value ?? 1), observed: `${count} item${count === 1 ? '' : 's'}` };
    }
    case 'max-items': {
      const count = Array.isArray(at) ? at.length : typeof at === 'number' ? at : 0;
      return { ok: count <= (check.value ?? 0), observed: `${count} item${count === 1 ? '' : 's'}` };
    }
    case 'non-empty': {
      const filled = Array.isArray(at) ? at.length > 0 : typeof at === 'string' ? at.trim().length > 0 : at !== undefined && at !== null;
      return { ok: filled, observed: filled ? 'present' : 'empty' };
    }
    case 'distinct': {
      const rows = items(at).map((row) => String(row[field] ?? ''));
      const limit = check.value ?? 0.8;
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const score = similarity(rows[i], rows[j]);
          if (score >= limit) {
            return { ok: false, observed: `items ${i + 1} and ${j + 1} repeat each other (${score.toFixed(2)})` };
          }
        }
      }
      return { ok: true, observed: `${rows.length} items, no pair above ${limit}` };
    }
    case 'verbatim': {
      const source = normalise(String(getPath(result, check.against ?? 'text') ?? ''));
      const rows = items(at);
      const missing = rows.filter((row) => {
        const text = normalise(String(row[field] ?? ''));
        return text.length > 0 && !source.includes(text);
      });
      return {
        ok: missing.length === 0,
        observed: missing.length === 0 ? `${rows.length} quoted` : `${missing.length} not in the source`,
      };
    }
  }
}

/**
 * Runs a skill against the host's capability path. Steps run in order; a check
 * that fails stops the run before the step it guards, which is what keeps a
 * short page from being padded to three points.
 */
export async function runSkill(skill: Skill, options: RunSkillOptions): Promise<SkillRun> {
  const maxSteps = Math.max(1, options.maxSteps ?? skill.stop.maxSteps ?? 4);
  const onCheckFail = skill.stop.onCheckFail ?? 'stop';
  const steps: SkillStepRecord[] = [];
  const checks: SkillCheckRecord[] = [];
  const results = new Map<string, unknown>();
  const record = (step: SkillStepRecord) => {
    steps.push(step);
    return step;
  };

  let stopped: SkillRun['stopped'];
  let ran = 0;

  for (const step of skill.steps) {
    const title = step.title ?? step.capabilityId;
    const base = { id: step.id, capabilityId: step.capabilityId, title };
    if (stopped) {
      record({ ...base, status: 'skipped', reason: 'check-failed' });
      continue;
    }
    if (steps.some((entry) => entry.status === 'failed')) {
      record({ ...base, status: 'skipped', reason: 'previous-failed' });
      continue;
    }
    if (ran >= maxSteps) {
      record({ ...base, status: 'skipped', reason: 'step-limit' });
      continue;
    }
    let args: Record<string, unknown> = { ...(step.args ?? {}) };
    if (step.input) {
      const value = getPath(results.get(step.input.step), step.input.path);
      if (value === undefined) {
        record({ ...base, status: 'skipped', reason: 'missing-input' });
        continue;
      }
      args = { ...args, [step.input.as]: value };
    }
    let result: unknown;
    try {
      result = await options.call(step.capabilityId, args);
      results.set(step.id, result);
      record({ ...base, status: 'ran', args, result });
      ran += 1;
    } catch (error) {
      record({
        ...base,
        status: 'failed',
        args,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const guards = skill.checks.filter((check) => check.after === step.id);
    for (const check of guards) {
      const outcome = evaluate(check, result);
      checks.push({ ...check, ...outcome });
      if (!outcome.ok && onCheckFail === 'stop') {
        stopped = { check: check.id, message: check.message };
        break;
      }
    }
  }

  const failed = steps.find((step) => step.status === 'failed');
  return {
    skillId: skill.id,
    title: skill.title,
    steps,
    checks,
    ok: !failed && !stopped && checks.every((check) => check.ok),
    ...(stopped ? { stopped } : {}),
    ...(failed ? { failedAt: failed.id } : {}),
  };
}
