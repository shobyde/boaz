import type { PlannedAlternate, PlannedStep, RequestPlan } from './plan.js';

/**
 * A plan is only worth making if something runs it. `planRequest` decides what a
 * two-request sentence means; this walks the steps in order, refuses the ones the
 * sentence never paid for, and reports each step so a host can show what
 * happened instead of inferring it from prose.
 *
 * The executor owns ordering, preconditions and recovery. It does not own
 * effects: the host passes `run`, which is the same path a single request
 * already takes. That keeps confirmation, validation and navigation in one
 * place, so a planned step cannot reach a control that a one-step request could
 * not.
 *
 * Recovery is the one thing a planner can do that a single call cannot: when a
 * capability throws or returns nothing, the runner-up for the same clause is a
 * fact the planner already ranked. It is not a guess about intent, and it is not
 * a retry of the same call.
 */

export type StepStatus = 'ran' | 'skipped' | 'failed';

export type SkipReason =
  | 'missing-argument'
  | 'not-on-route'
  | 'previous-failed'
  | 'step-limit';

/** Why one candidate did not serve the step. */
export type AttemptOutcome = 'threw' | 'empty';

export interface StepAttempt {
  capabilityId: string;
  outcome: AttemptOutcome;
  error?: string;
}

export interface ExecutedStep {
  capabilityId: string;
  title: string;
  /** The clause the visitor wrote, kept so a trace can quote it. */
  text: string;
  status: StepStatus;
  reason?: SkipReason;
  result?: unknown;
  error?: string;
  /** Candidates that did not work, in the order they were tried. */
  attempts?: StepAttempt[];
}

export interface PlanExecution {
  steps: ExecutedStep[];
  /** One sentence covering what ran, what was tried and what was refused. */
  summary: string;
  /** True when every step ran. */
  ok: boolean;
  /** The step that stopped the plan, when one failed. */
  failedAt?: string;
}

export interface ExecuteOptions {
  /** Runs one step. Pass the host's ordinary capability path, not a second one. */
  run: (step: PlannedStep) => Promise<unknown> | unknown;
  /**
   * Runs a capability by id, for the recovery candidates. A host that routes on
   * text cannot reach a runner-up, because the text would route the same way
   * again; this is the hook that makes recovery real instead of decorative.
   */
  runAlternate?: (step: PlannedStep) => Promise<unknown> | unknown;
  /** The route the visitor is on now. Required to honour `needs: 'route'`. */
  currentRoute?: () => string;
  /** Refuse work past this many executed steps. Default 4. */
  maxSteps?: number;
  /** Try runner-ups after a failure. Default true. */
  recover?: boolean;
  /** Cap on runner-ups tried per step. Default 2. */
  maxAlternates?: number;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "opened the archive, then copied your email" */
function phraseRan(executed: ExecutedStep[]): string {
  const titles = executed.map((step) => lowerFirst(step.title || step.capabilityId));
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]}, then ${titles[1]}`;
  return `${titles.slice(0, -1).join(', ')}, then ${titles[titles.length - 1]}`;
}

/**
 * What counts as "the capability came back with nothing". Only a handler that
 * produced no value at all: `undefined`, `null` or an empty string. An empty
 * array is an answer ("no project lists Cobol"), and recovering from it would
 * overwrite a correct result with an unrelated one.
 */
export function isEmptyResult(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export async function executePlan(
  plan: RequestPlan,
  options: ExecuteOptions,
): Promise<PlanExecution> {
  const maxSteps = Math.max(1, options.maxSteps ?? 4);
  const maxAlternates = Math.max(0, options.maxAlternates ?? 2);
  const executed: ExecutedStep[] = [];
  const ran: ExecutedStep[] = [];
  const skipped: Array<{ step: ExecutedStep; reason: SkipReason }> = [];
  const notes: string[] = [];
  const record = (step: ExecutedStep) => {
    executed.push(step);
    return step;
  };

  for (const step of plan.steps) {
    const base = { capabilityId: step.capabilityId, title: step.title, text: step.text };
    if (failedAt(executed)) {
      skipped.push({ step: record({ ...base, status: 'skipped', reason: 'previous-failed' }), reason: 'previous-failed' });
      continue;
    }
    if (ran.length >= maxSteps) {
      skipped.push({ step: record({ ...base, status: 'skipped', reason: 'step-limit' }), reason: 'step-limit' });
      continue;
    }
    // A step that needs an argument its clause never stated is not runnable, and
    // guessing one is how a plan opens the wrong card.
    if (step.needs === 'args') {
      skipped.push({
        step: record({ ...base, status: 'skipped', reason: 'missing-argument' }),
        reason: 'missing-argument',
      });
      continue;
    }
    // The step acts on a page an earlier step opens. If that navigation did not
    // land, the control is not mounted and running it would throw.
    if (step.needs === 'route') {
      const now = options.currentRoute?.();
      const wanted = step.route ?? null;
      if (!now || (wanted && now !== wanted)) {
        skipped.push({
          step: record({ ...base, status: 'skipped', reason: 'not-on-route' }),
          reason: 'not-on-route',
        });
        continue;
      }
    }

    const candidates: Array<PlannedAlternate & { primary?: boolean }> = [
      { capabilityId: step.capabilityId, title: step.title, kind: step.kind, args: step.args, primary: true },
      ...(options.recover === false ? [] : (step.alternates ?? []).slice(0, maxAlternates)),
    ];
    const attempts: StepAttempt[] = [];
    let finished: ExecutedStep | undefined;
    for (const candidate of candidates) {
      const candidateStep: PlannedStep = candidate.primary
        ? step
        : { ...step, capabilityId: candidate.capabilityId, title: candidate.title, kind: candidate.kind, args: candidate.args };
      // An empty result is only a failure when there is another candidate left to
      // serve the clause; with nothing to fall back to it is the answer.
      const recoverable = candidates.length > 1 && candidate !== candidates[candidates.length - 1];
      try {
        const runner = candidate.primary ? options.run : options.runAlternate ?? options.run;
        const result = await runner(candidateStep);
        if (isEmptyResult(result) && recoverable) {
          attempts.push({ capabilityId: candidate.capabilityId, outcome: 'empty' });
          continue;
        }
        finished = record({
          ...base,
          capabilityId: candidate.capabilityId,
          title: candidate.title,
          status: 'ran',
          ...(result === undefined ? {} : { result }),
          ...(attempts.length > 0 ? { attempts: [...attempts] } : {}),
        });
        ran.push(finished);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ capabilityId: candidate.capabilityId, outcome: 'threw', error: message });
      }
    }
    if (!finished) {
      const last = attempts[attempts.length - 1];
      record({
        ...base,
        status: 'failed',
        ...(last?.error ? { error: last.error } : { error: 'returned nothing' }),
        ...(attempts.length > 1 ? { attempts: [...attempts] } : {}),
      });
      // Keep walking so the record names every step the failure cost, instead of
      // ending the report at the one that broke.
      continue;
    }
    if (attempts.length > 0) {
      const first = attempts[0];
      const reason = first.outcome === 'threw' ? 'failed' : 'returned nothing';
      notes.push(
        `${lowerFirst(step.title || step.capabilityId)} ${reason}, so I tried ${lowerFirst(finished.title || finished.capabilityId)} instead.`,
      );
    }
  }

  const failed = executed.find((step) => step.status === 'failed');
  const ok = !failed && skipped.length === 0 && ran.length === plan.steps.length;
  const parts: string[] = [];
  if (ran.length > 0) {
    parts.push(`I did ${ran.length === 1 ? 'one thing' : `${ran.length} things`}: ${phraseRan(ran)}.`);
  }
  parts.push(...notes);
  for (const { step, reason } of skipped) {
    const name = lowerFirst(step.title || step.capabilityId);
    if (reason === 'missing-argument') parts.push(`I did not run ${name}, because the sentence never said which one.`);
    else if (reason === 'not-on-route') parts.push(`I did not run ${name}, because the page it needs did not open.`);
    else if (reason === 'previous-failed') parts.push(`${name} did not run.`);
    else parts.push(`I stopped before ${name}.`);
  }
  if (failed) {
    parts.push(`${lowerFirst(failed.title || failed.capabilityId)} failed: ${failed.error ?? 'unknown error'}.`);
  }

  return { steps: executed, summary: parts.join(' '), ok, ...(failed ? { failedAt: failed.capabilityId } : {}) };
}

function failedAt(executed: ExecutedStep[]): boolean {
  return executed.some((step) => step.status === 'failed');
}
