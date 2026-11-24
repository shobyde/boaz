import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProbes } from '../src/cli/probes.js';
import { knowledgeSource } from '../src/cli/harness.js';
import { runAudit } from '../src/cli/audit.js';
import { runBench } from '../src/cli/bench.js';
import type { ManifestCapability } from '../src/core/types.js';

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'client-agent-cli-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probe files', () => {
  it('reads { questions } and a bare array', async () => {
    const dir = await workspace({
      'a.json': JSON.stringify({ questions: [{ question: 'open billing', expect: 'billing.open' }] }),
      'b.json': JSON.stringify([{ question: 'where is it', expect: 'x.y', args: { id: '1' } }]),
    });
    expect((await loadProbes(path.join(dir, 'a.json')))[0]?.expect).toBe('billing.open');
    const second = (await loadProbes(path.join(dir, 'b.json')))[0];
    expect(second?.args).toEqual({ id: '1' });
  });

  it('rejects a probe without a question', async () => {
    const dir = await workspace({ 'bad.json': JSON.stringify({ questions: [{ expect: 'a.b' }] }) });
    await expect(loadProbes(path.join(dir, 'bad.json'))).rejects.toThrow(/needs a "question"/);
  });
});

describe('knowledge provenance', () => {
  const capabilities: ManifestCapability[] = [
    {
      id: 'about.sho',
      kind: 'knowledge',
      title: 'About',
      description: 'Who he is',
      keywords: ['about'],
      knowledge: 'Sho is a software engineer with twelve years of experience building platforms.',
    },
  ];

  it('names the capability a quoted paragraph came from', () => {
    expect(
      knowledgeSource(capabilities, 'Sho is a software engineer with twelve years of experience.'),
    ).toBe('about.sho');
  });

  it('does not claim prose that only starts with a short word', () => {
    expect(knowledgeSource(capabilities, 'Sho is busy.')).toBeUndefined();
  });
});

describe('audit', () => {
  it('passes when the engine plans the expected capability and fails otherwise', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = await workspace({
      'setup.mjs': `
        export function createEngine() {
          return {
            async complete(request) {
              const question = request.messages[0].content;
              if (question.includes('open billing')) {
                return { text: '\\u0060\\u0060\\u0060json\\n{"tool":"billing.open","arguments":{}}\\n\\u0060\\u0060\\u0060' };
              }
              return { text: 'I can only help with the screens in this app.' };
            },
          };
        }
      `,
      'probes.json': JSON.stringify({
        questions: [
          { question: 'open billing', expect: 'billing.open' },
          { question: 'delete everything', expect: 'billing.delete' },
        ],
      }),
    });
    const code = await runAudit({
      probes: path.join(dir, 'probes.json'),
      module: path.join(dir, 'setup.mjs'),
      quiet: true,
    });
    expect(code).toBe(1);
  });

  it('is green when every probe lands', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = await workspace({
      'setup.mjs': `
        export function createEngine() {
          return { async complete() { return { text: '\\u0060\\u0060\\u0060json\\n{"tool":"billing.open","arguments":{}}\\n\\u0060\\u0060\\u0060' }; } };
        }
      `,
      'probes.json': JSON.stringify({ questions: [{ question: 'open billing', expect: 'billing.open' }] }),
    });
    expect(
      await runAudit({ probes: path.join(dir, 'probes.json'), module: path.join(dir, 'setup.mjs'), quiet: true }),
    ).toBe(0);
  });
});

describe('bench', () => {
  it('scores paraphrases on their facts and keeps identical answers stable', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = await workspace({
      'setup.mjs': `
        export function createEngine() {
          return {
            async complete(request) {
              const question = request.messages[0].content;
              const lead = question.includes('which') ? 'Readback and Groundglass' : 'Both of them, Readback and Groundglass';
              return { text: lead + ' list Python 3.10+.' };
            },
          };
        }
      `,
      'probes.json': JSON.stringify({
        questions: [
          { question: 'which projects use python?', intent: 'using', must: ['Readback', 'Groundglass'] },
          { question: "what's built with python?", intent: 'using', must: ['Readback', 'Groundglass'] },
        ],
      }),
    });
    const out = path.join(dir, 'results.json');
    const code = await runBench({
      probes: path.join(dir, 'probes.json'),
      module: path.join(dir, 'setup.mjs'),
      json: out,
    });
    expect(code).toBe(0);
    const summary = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(summary.fidelity).toBe(1);
    expect(summary.similarity).toBeLessThan(1);
    expect(summary.rows[0].stable).toBe(true);
  });

  it('refuses to score intents with no facts to check', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = await workspace({
      'setup.mjs': 'export function createEngine() { return { async complete() { return { text: "x" }; } }; }',
      'probes.json': JSON.stringify({ questions: [{ question: 'open billing', expect: 'billing.open' }] }),
    });
    expect(
      await runBench({ probes: path.join(dir, 'probes.json'), module: path.join(dir, 'setup.mjs') }),
    ).toBe(2);
  });
});
