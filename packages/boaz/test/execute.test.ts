import { describe, expect, it } from 'vitest';
import { planRequest } from '../src/core/plan.js';
import { executePlan } from '../src/core/execute.js';
import type { ManifestCapability } from '../src/core/types.js';

const capabilities: ManifestCapability[] = [
  { id: 'blog.open_archive', kind: 'action', title: 'Open the full archive', description: '', keywords: ['archive', 'all posts', 'older posts'] },
  { id: 'blog.open_newest', kind: 'action', title: 'Read the newest article', description: '', keywords: ['newest', 'latest', 'newest article'] },
  { id: 'contact.copy_email', kind: 'action', title: 'Copy the email address', description: '', keywords: ['copy email', 'email address', 'clipboard'] },
  { id: 'projects.expand', kind: 'action', title: 'Expand a project card', description: '', keywords: ['expand', 'architecture'], paramsSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string', enum: ['Hobnob', 'Readback'] } } } },
  { id: 'site.blog', kind: 'route', title: 'Engineering log', description: '', route: '/#blog', keywords: ['blog', 'writing', 'posts'] },
  { id: 'site.projects', kind: 'route', title: 'Selected projects', description: '', route: '/#projects', keywords: ['projects', 'work', 'portfolio'] },
];

const plan = (query: string) => planRequest(query, { capabilities });

/** A host that records what it was asked to do, in order. */
function recorder(start = '/') {
  const calls: string[] = [];
  let route = start;
  return {
    calls,
    currentRoute: () => route,
    run: (step: { capabilityId: string }) => {
      calls.push(step.capabilityId);
      const capability = capabilities.find((entry) => entry.id === step.capabilityId);
      if (capability?.kind === 'route') route = capability.route ?? '/';
      return { ok: true };
    },
  };
}

describe('executePlan', () => {
  it('runs both steps of a two-request sentence in order', async () => {
    const host = recorder();
    const result = await executePlan(plan('open the archive and copy his email'), host);
    expect(host.calls).toEqual(['blog.open_archive', 'contact.copy_email']);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('I did 2 things: open the full archive, then copy the email address.');
  });

  it('honours a route precondition after the route step lands', async () => {
    const host = recorder();
    const result = await executePlan(plan('take me to the projects then expand hobnob'), host);
    expect(host.calls).toEqual(['site.projects', 'projects.expand']);
    expect(result.ok).toBe(true);
  });

  it('refuses a step whose argument the sentence never stated', async () => {
    const host = recorder();
    const result = await executePlan(plan('open the archive and expand the card'), host);
    expect(host.calls).toEqual(['blog.open_archive']);
    expect(result.steps[1].status).toBe('skipped');
    expect(result.steps[1].reason).toBe('missing-argument');
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      'I did one thing: open the full archive. I did not run expand a project card, because the sentence never said which one.',
    );
  });

  it('stops at the first failure and says which step failed', async () => {
    let first = true;
    const result = await executePlan(plan('open the archive and copy his email'), {
      run: (step) => {
        if (first) {
          first = false;
          return undefined;
        }
        throw new Error('clipboard blocked');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe('contact.copy_email');
    expect(result.summary).toContain('clipboard blocked');
  });

  it('does nothing for a sentence that is not a plan', async () => {
    const host = recorder();
    const result = await executePlan(plan('open the archive'), host);
    expect(host.calls).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.summary).toBe('');
  });

  it('enforces the step limit', async () => {
    const host = recorder();
    const result = await executePlan(plan('open the archive, then take me to the blog, then copy his email'), {
      ...host,
      maxSteps: 2,
    });
    expect(host.calls).toHaveLength(2);
    expect(result.steps[2].reason).toBe('step-limit');
  });
});
