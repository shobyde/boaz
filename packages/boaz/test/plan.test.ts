import { describe, expect, it } from 'vitest';
import { planRequest } from '../src/core/plan.js';
import type { ManifestCapability } from '../src/core/types.js';

const capabilities: ManifestCapability[] = [
  { id: 'blog.open_archive', kind: 'action', title: 'Open the full archive', description: '', keywords: ['archive', 'all posts', 'older posts'] },
  { id: 'blog.open_newest', kind: 'action', title: 'Read the newest article', description: '', keywords: ['newest', 'latest', 'newest article'] },
  { id: 'blog.card', kind: 'action', title: 'Show the newest article card', description: '', keywords: ['article card', 'newest post'] },
  { id: 'contact.copy_email', kind: 'action', title: 'Copy the email address', description: '', keywords: ['copy email', 'email address', 'clipboard'] },
  { id: 'contact.open_linkedin', kind: 'action', title: 'Open LinkedIn', description: '', keywords: ['linkedin', 'profile'] },
  { id: 'resume.print', kind: 'action', title: 'Open the printable resume', description: '', keywords: ['resume', 'cv', 'print'] },
  { id: 'projects.expand', kind: 'action', title: 'Expand a project card', description: '', keywords: ['expand', 'architecture'], paramsSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string', enum: ['Hobnob', 'Readback'] } } } },
  { id: 'site.blog', kind: 'route', title: 'Engineering log', description: '', route: '/#blog', keywords: ['blog', 'writing', 'posts'] },
  { id: 'site.projects', kind: 'route', title: 'Selected projects', description: '', route: '/#projects', keywords: ['projects', 'work', 'portfolio'] },
  { id: 'knowledge.skills', kind: 'knowledge', title: 'Skills and stack', description: '', keywords: ['skills', 'stack', 'technologies'] },
];

const plan = (query: string) => planRequest(query, { capabilities });

describe('planRequest', () => {
  it('splits two requests joined by a connective whose right side has a verb', () => {
    const result = plan('open the archive and copy his email');
    expect(result.steps.map((step) => step.capabilityId)).toEqual(['blog.open_archive', 'contact.copy_email']);
    expect(result.steps[0].verb).toBe('open');
    expect(result.steps[1].verb).toBe('copy');
    expect(result.summary).toBe('Open the full archive, then copy the email address');
  });

  it('keeps a list of objects as one request', () => {
    const result = plan('show me the projects and the blog');
    expect(result.steps).toHaveLength(0);
    expect(result.declined).toBe('no-second-verb');
  });

  it('declines a single request with no connective', () => {
    expect(plan('open the archive').declined).toBe('single-request');
  });

  it('reads a required enum argument off the clause that needs it', () => {
    const result = plan('take me to the projects then expand hobnob');
    expect(result.steps.map((step) => step.capabilityId)).toEqual(['site.projects', 'projects.expand']);
    expect(result.steps[1].args).toEqual({ project: 'Hobnob' });
    expect(result.steps[1].needs).toBe('route');
  });

  it('blocks a step whose required argument is not stated', () => {
    const result = plan('open the archive and expand the card');
    expect(result.steps[1].args).toBeNull();
    expect(result.steps[1].needs).toBe('args');
  });

  it('skips filler and keeps scanning past the first connective', () => {
    const result = plan('open the archive, then take me to the blog, then copy his email');
    expect(result.steps.map((step) => step.capabilityId)).toEqual([
      'blog.open_archive',
      'site.blog',
      'contact.copy_email',
    ]);
  });

  it('declines instead of guessing when a clause matches nothing', () => {
    const result = plan('open the archive and visit zzzzqqqq');
    expect(result.declined).toBe('unmapped-clause');
    expect(result.failed).toBe('visit zzzzqqqq');
  });

  it('falls back to a knowledge paragraph when no place or action matches the clause', () => {
    const result = plan('show me the skills and open linkedin');
    expect(result.steps.map((step) => step.capabilityId)).toEqual(['knowledge.skills', 'contact.open_linkedin']);
  });
});
