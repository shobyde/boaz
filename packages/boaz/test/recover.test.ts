import { describe, expect, it } from 'vitest';
import { executePlan } from '../src/core/execute.js';
import { planRequest } from '../src/core/plan.js';
import type { ManifestCapability } from '../src/core/types.js';

const capabilities: ManifestCapability[] = [
  { id: 'blog.open_newest', kind: 'action', title: 'Read the newest article', description: '', keywords: ['newest article', 'newest post', 'latest post'] },
  { id: 'blog.card', kind: 'action', title: 'Show the newest article card', description: '', keywords: ['article card', 'post card'] },
  { id: 'contact.copy_email', kind: 'action', title: 'Copy the email address', description: '', keywords: ['copy email', 'email address'] },
  { id: 'site.blog', kind: 'route', title: 'Engineering log', description: '', route: '/#blog', keywords: ['blog', 'posts', 'writing'] },
  { id: 'site.contact', kind: 'route', title: 'Contact', description: '', route: '/#contact', keywords: ['contact'] },
];

const plan = (query: string) => planRequest(query, { capabilities });

/** Records every capability it was asked to run, in order, and can be told to fail. */
function recorder(fail: { throws?: string[]; empty?: string[] } = {}) {
  const calls: string[] = [];
  const throws = new Set(fail.throws ?? []);
  const empty = new Set(fail.empty ?? []);
  let route = '/';
  return {
    calls,
    currentRoute: () => route,
    run: (step: { capabilityId: string }) => {
      calls.push(step.capabilityId);
      if (throws.has(step.capabilityId)) throw new Error('handler threw');
      if (empty.has(step.capabilityId)) return undefined;
      const capability = capabilities.find((entry) => entry.id === step.capabilityId);
      if (capability?.kind === 'route') route = capability.route ?? '/';
      return { ran: step.capabilityId };
    },
  };
}

const firstStep = (query: string) => plan(query).steps[0];

describe('plan alternates', () => {
  it('lists the runner-ups for a clause, best first, without routes', () => {
    const step = firstStep('read the newest post and copy his email');
    expect(step.capabilityId).toBe('blog.open_newest');
    const ids = (step.alternates ?? []).map((alternate) => alternate.capabilityId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(step.capabilityId);
    expect(step.alternates!.every((alternate) => alternate.kind !== 'route')).toBe(true);
  });

  it('gives a route step no alternates, because a wrong page is worse than none', () => {
    const step = firstStep('go to the contact page and copy his email');
    expect(step.kind).toBe('route');
    expect(step.alternates).toBeUndefined();
  });
});

describe('executePlan recovery', () => {
  it('runs the runner-up when the chosen capability throws, and says so', async () => {
    const host = recorder({ throws: ['blog.open_newest'] });
    const result = await executePlan(plan('read the newest post and copy his email'), host);
    expect(result.ok).toBe(true);
    expect(host.calls).toEqual(['blog.open_newest', 'blog.card', 'contact.copy_email']);
    expect(result.steps[0].capabilityId).toBe('blog.card');
    expect(result.steps[0].attempts).toEqual([
      { capabilityId: 'blog.open_newest', outcome: 'threw', error: 'handler threw' },
    ]);
    expect(result.summary).toContain('so I tried');
  });

  it('runs the runner-up when the chosen capability returns nothing', async () => {
    const host = recorder({ empty: ['blog.open_newest'] });
    const result = await executePlan(plan('read the newest post and copy his email'), host);
    expect(result.ok).toBe(true);
    expect(result.steps[0].capabilityId).toBe('blog.card');
    expect(result.steps[0].attempts?.[0].outcome).toBe('empty');
    expect(result.summary).toContain('returned nothing');
  });

  it('treats an empty list as an answer, not a failure', async () => {
    const calls: string[] = [];
    const result = await executePlan(plan('read the newest post and copy his email'), {
      run: (step) => {
        calls.push(step.capabilityId);
        return [];
      },
    });
    expect(calls).toEqual(['blog.open_newest', 'contact.copy_email']);
    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain('so I tried');
  });

  it('stops when every candidate fails, and runs nothing after it', async () => {
    const step = firstStep('read the newest post and copy his email');
    const every = [step.capabilityId, ...(step.alternates ?? []).map((alternate) => alternate.capabilityId)];
    const host = recorder({ throws: every });
    const result = await executePlan(plan('read the newest post and copy his email'), host);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('blog.open_newest');
    expect(result.steps[1].status).toBe('skipped');
    expect(result.steps[1].reason).toBe('previous-failed');
    expect(host.calls).toEqual(every);
  });

  it('can be turned off, which is the behaviour before recovery existed', async () => {
    const host = recorder({ throws: ['blog.open_newest'] });
    const result = await executePlan(plan('read the newest post and copy his email'), { ...host, recover: false });
    expect(result.ok).toBe(false);
    expect(host.calls).toEqual(['blog.open_newest']);
    expect(result.summary).toContain('handler threw');
  });
});
