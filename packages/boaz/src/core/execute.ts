import type { PlannedStep, RequestPlan } from './plan.js';

/**
 * A plan is only worth making if something runs it. `planRequest` decides what a
 * two-request sentence means; this walks the steps in order, refuses the ones the
 * sentence never paid for, and reports each step so a host can show what
 * happened instead of inferring it from prose.
 *
 * The executor owns ordering and preconditions. It does not own effects: the
 * host passes `run`, which is the same path a single request already takes. That
 * keeps confirmation, validation and navigation in one place, so a planned step
 * cannot reach a control that a one-step request could not.
 */

export type StepStatus = 'ran' | 'skipped' | 'failed';

export type SkipReason =
  | 'missing-argument'
  | 'not-on-route'
  | 'previous-failed'
  | 'step-limit';

export interface ExecutedStep {
  capabilityId: string;
  title: string;
  /** The clause the visitor wrote, kept so a trace can quote it. */
  text: string;
  status: StepStatus;
  reason?: SkipReason;
  result?: unknown;
  error?: string;
}

export interface PlanExecution {
  steps: ExecutedStep[];
  /** One sentence covering what ran and what was refused. Empty when nothing ran. */
  summary: string;
  /** True when every step ran. */
  ok: boolean;
  /** The step that stopped the plan, when one failed. */
  failedAt?: string;
}

export interface ExecuteOptions {
  /** Runs one step. Pass the host's ordinary capability path, not a second one. */
  run: (step: PlannedStep) => Promise<unknown> | unknown;
  /** The route the visitor is on now. Required to honour `needs: 'route'`. */
  currentRoute?: () => string;
  /** Refuse work past this many executed steps. Default 4. */
  maxSteps?: number;
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

export async function executePlan(
  plan: RequestPlan,
  options: ExecuteOptions,
): Promise<PlanExecution> {
  const maxSteps = Math.max(1, options.maxSteps ?? 4);
  const executed: ExecutedStep[] = [];
  const ran: ExecutedStep[] = [];
  const skipped: Array<{ step: ExecutedStep; reason: SkipReason }> = [];
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
    try {
      const result = await options.run(step);
      const done = record({ ...base, status: 'ran', ...(result === undefined ? {} : { result }) });
      ran.push(done);
    } catch (error) {
      record({
        ...base,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  const failed = executed.find((step) => step.status === 'failed');
  const ok = !failed && skipped.length === 0 && ran.length === plan.steps.length;
  const parts: string[] = [];
  if (ran.length > 0) {
    parts.push(`I did ${ran.length === 1 ? 'one thing' : `${ran.length} things`}: ${phraseRan(ran)}.`);
  }
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
