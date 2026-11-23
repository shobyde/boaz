import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChromeAIEngine,
  detectChromeAI,
  isChromeAIAvailable,
} from '../src/chrome-ai/index.js';

const globals = globalThis as unknown as { LanguageModel?: unknown };
const original = globals.LanguageModel;

afterEach(() => {
  if (original === undefined) delete globals.LanguageModel;
  else globals.LanguageModel = original;
});

describe('chrome built-in model adapter', () => {
  it('reports unsupported when the browser has no Prompt API', async () => {
    delete globals.LanguageModel;
    expect(isChromeAIAvailable()).toBe(false);
    expect(await detectChromeAI()).toBe('unsupported');
  });

  it('passes the browser availability through', async () => {
    globals.LanguageModel = {
      availability: async () => 'downloadable',
      create: async () => ({ prompt: async () => '' }),
    };
    expect(await detectChromeAI()).toBe('downloadable');
  });

  it('treats a throwing availability call as unsupported', async () => {
    globals.LanguageModel = {
      availability: async () => {
        throw new Error('nope');
      },
      create: async () => ({ prompt: async () => '' }),
    };
    expect(await detectChromeAI()).toBe('unsupported');
  });

  it('flattens the conversation into one prompt and returns the reply', async () => {
    const prompts: string[] = [];
    const create = vi.fn(async () => ({
      prompt: async (input: string) => {
        prompts.push(input);
        return '```json\n{"tool":"site.about","arguments":{}}\n```';
      },
    }));
    globals.LanguageModel = { availability: async () => 'available', create };

    const engine = createChromeAIEngine();
    const reply = await engine.complete({
      messages: [
        { role: 'system', content: 'You are the site assistant.' },
        { role: 'user', content: 'where is his experience?' },
      ],
      tools: [],
    });

    expect(reply.text).toContain('site.about');
    expect(prompts[0]).toContain('You are the site assistant.');
    expect(prompts[0]).toContain('USER: where is his experience?');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('creates one session and reuses it for later turns', async () => {
    const create = vi.fn(async () => ({ prompt: async () => 'ok' }));
    globals.LanguageModel = { availability: async () => 'available', create };
    const engine = createChromeAIEngine();
    const request = {
      messages: [
        { role: 'system' as const, content: 'system' },
        { role: 'user' as const, content: 'one' },
      ],
      tools: [],
    };
    await engine.complete(request);
    await engine.complete(request);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when asked to run unsupported', async () => {
    delete globals.LanguageModel;
    const engine = createChromeAIEngine();
    await expect(
      engine.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    ).rejects.toThrow(/no built-in language model/);
  });
});
