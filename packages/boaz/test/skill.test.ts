import { describe, expect, it } from 'vitest';
import { matchSkill, runSkill, selectSkill } from '../src/core/skill.js';
import type { Skill } from '../src/core/skill.js';

const pages: Record<string, { sections: { label: string; text: string }[] }> = {
  long: {
    sections: [
      { label: 'About', text: 'Sho builds web applications. He works across frontend and backend. Twelve years of experience.' },
      { label: 'Projects', text: 'Hobnob records meetings in the browser. Readback tracks reading progress. Boaz routes questions without a model.' },
      { label: 'Contact', text: 'Email him at shobyde@gmail.com. LinkedIn is the other way in. Both reach the same inbox.' },
    ],
  },
  short: {
    sections: [{ label: 'About', text: 'Sho builds web applications.' }],
  },
  duplicate: {
    sections: [
      { label: 'About', text: 'Hobnob records meetings in the browser.' },
      { label: 'Projects', text: 'Hobnob records meetings in the browser.' },
      { label: 'Contact', text: 'Readback tracks reading progress.' },
    ],
  },
};

const skill: Skill = {
  id: 'page.three_points',
  title: 'Summarise this page in three points',
  trigger: { phrases: ['summarise this page', 'three points from this page'] },
  steps: [
    { id: 'sections', capabilityId: 'page.sections' },
    {
      id: 'points',
      capabilityId: 'page.points',
      input: { step: 'sections', path: 'text', as: 'text' },
    },
  ],
  checks: [
    { id: 'enough', after: 'sections', kind: 'min-items', path: 'sections', value: 3, message: 'This page is too short to summarise in three points.' },
    { id: 'three', after: 'points', kind: 'max-items', path: 'points', value: 3, message: 'Asked for three points or fewer.' },
  ],
  stop: { onCheckFail: 'stop' },
};

/** A host with the two capabilities the skill declares, over a named page. */
function host(page: keyof typeof pages) {
  const calls: { capabilityId: string; args: Record<string, unknown> }[] = [];
  const call = (capabilityId: string, args: Record<string, unknown>) => {
    calls.push({ capabilityId, args });
    const data = pages[page];
    if (capabilityId === 'page.sections') {
      return { text: data.sections.map((section) => section.text).join(' '), sections: data.sections };
    }
    if (capabilityId === 'page.points') {
      // One point per section, trimmed to a sentence: what a summariser would do.
      // It echoes the text it read, which is what makes the verbatim check possible.
      const source = String(args.text ?? '');
      const points = source
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((text) => ({ text, source: 'page' }));
      return { points, text: source };
    }
    throw new Error(`no capability ${capabilityId}`);
  };
  return { call, calls };
}

describe('matchSkill', () => {
  it('matches a trigger phrase as whole words', () => {
    expect(matchSkill(skill, 'summarise this page in three points')).toBe('summarise this page');
    expect(matchSkill(skill, 'Can you summarize this page?')).toBeNull();
    expect(matchSkill(skill, 'summarise this pager')).toBeNull();
  });

  it('prefers the longest phrase across skills', () => {
    const broad: Skill = { ...skill, id: 'broad', trigger: { phrases: ['summarise'] } };
    expect(selectSkill([broad, skill], 'summarise this page')?.id).toBe('page.three_points');
  });

  it('honours an extra condition', () => {
    const guarded: Skill = { ...skill, trigger: { ...skill.trigger, require: /^\s*tl;?dr/i } };
    expect(matchSkill(guarded, 'summarise this page')).toBeNull();
  });
});

describe('runSkill', () => {
  it('passes the previous result into the next step', async () => {
    const { call, calls } = host('long');
    const run = await runSkill(skill, { call });
    expect(run.ok).toBe(true);
    expect(calls[1].capabilityId).toBe('page.points');
    expect(String(calls[1].args.text)).toContain('Hobnob records meetings');
    expect(run.checks.every((check) => check.ok)).toBe(true);
  });

  it('stops before the step a failed check guards', async () => {
    const { call, calls } = host('short');
    const run = await runSkill(skill, { call });
    expect(run.ok).toBe(false);
    expect(run.stopped?.check).toBe('enough');
    expect(calls.map((entry) => entry.capabilityId)).toEqual(['page.sections']);
    expect(run.steps[1].status).toBe('skipped');
    expect(run.steps[1].reason).toBe('check-failed');
  });

  it('records the observed value behind a failure', async () => {
    const { call } = host('short');
    const run = await runSkill(skill, { call });
    expect(run.checks[0].observed).toBe('1 item');
  });

  it('fails the step that throws and skips the rest', async () => {
    const run = await runSkill(skill, {
      call: () => {
        throw new Error('handler threw');
      },
    });
    expect(run.failedAt).toBe('sections');
    expect(run.steps[1].reason).toBe('previous-failed');
  });

  it('does not stop when the skill says continue', async () => {
    const forgiving: Skill = { ...skill, stop: { onCheckFail: 'continue' } };
    const { call } = host('short');
    const run = await runSkill(forgiving, { call });
    expect(run.steps.every((step) => step.status === 'ran')).toBe(true);
    expect(run.ok).toBe(false);
    expect(run.stopped).toBeUndefined();
  });

  it('catches two points that say the same thing', async () => {
    const distinct: Skill = {
      ...skill,
      checks: [{ id: 'varied', after: 'points', kind: 'distinct', path: 'points', value: 0.8, message: 'Two points repeat each other.' }],
    };
    const { call } = host('duplicate');
    const run = await runSkill(distinct, { call });
    expect(run.checks[0].ok).toBe(false);
    expect(run.checks[0].observed).toContain('repeat each other');
  });

  it('requires every point to be quoted from the source', async () => {
    const grounded: Skill = {
      ...skill,
      checks: [{ id: 'quoted', after: 'points', kind: 'verbatim', path: 'points', against: 'text', message: 'A point was not in the page.' }],
    };
    const { call } = host('long');
    const good = await runSkill(grounded, { call });
    expect(good.checks[0].ok).toBe(true);
    const invented = await runSkill(grounded, {
      call: (id, args) => {
        if (id === 'page.points') return { points: [{ text: 'He invented this claim.' }], text: String(args.text) };
        return { text: 'Sho builds web applications.', sections: pages.long.sections };
      },
    });
    expect(invented.checks[0].ok).toBe(false);
  });

  it('refuses a step whose input never arrived', async () => {
    const broken: Skill = {
      ...skill,
      steps: [skill.steps[0], { id: 'points', capabilityId: 'page.points', input: { step: 'sections', path: 'missing', as: 'text' } }],
      checks: [],
    };
    const { call, calls } = host('long');
    const run = await runSkill(broken, { call });
    expect(run.steps[1].reason).toBe('missing-input');
    expect(calls).toHaveLength(1);
  });
});

