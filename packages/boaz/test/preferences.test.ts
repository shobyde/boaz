import { describe, expect, it } from 'vitest';
import { createPreferenceMemory } from '../src/core/preferences.js';

const DECLARATIONS = [
  { id: 'register', values: ['terse', 'normal', 'explanatory'], defaultValue: 'normal' },
  { id: 'citations', values: ['on', 'off'] },
];

const store = () => createPreferenceMemory({ preferences: DECLARATIONS });

describe('preferences: stated values become facts', () => {
  it('reports the default before anything is stated', () => {
    const memory = store();
    expect(memory.get('register')).toBe('normal');
    expect(memory.get('citations')).toBeNull();
    expect(memory.facts()).toEqual([]);
  });

  it('records a stated value as a prefers() assertion', () => {
    const memory = store();
    const entry = memory.record('register', 'terse', { utterance: 'keep it short' });
    expect(entry).toMatchObject({ id: 'register', value: 'terse', turn: 1, utterance: 'keep it short' });
    expect(memory.get('register')).toBe('terse');
    expect(memory.facts()).toEqual(['prefers(register, terse)']);
  });

  it('refuses a value the host never declared, instead of storing it', () => {
    const memory = store();
    expect(memory.record('register', 'french')).toBeNull();
    expect(memory.record('tone', 'formal')).toBeNull();
    expect(memory.get('register')).toBe('normal');
    expect(memory.facts()).toEqual([]);
  });

  it('keeps the newest value and the assertion it implies', () => {
    const memory = store();
    memory.record('register', 'terse');
    memory.record('register', 'explanatory');
    expect(memory.get('register')).toBe('explanatory');
    expect(memory.stated('register')).toHaveLength(2);
    expect(memory.facts()).toEqual(['prefers(register, explanatory)']);
  });

  it('counts preferences, not turns, and keeps the utterance', () => {
    const memory = store();
    memory.record('register', 'terse', { utterance: 'keep it short' });
    memory.record('citations', 'on', { utterance: 'always cite sources' });
    expect(memory.stated().map((entry) => [entry.id, entry.turn])).toEqual([
      ['register', 1],
      ['citations', 2],
    ]);
    expect(memory.facts()).toEqual(['prefers(register, terse)', 'prefers(citations, on)']);
  });

  it('resets one key or all of them back to the declaration default', () => {
    const memory = store();
    memory.record('register', 'terse');
    memory.record('citations', 'on');
    memory.reset('register');
    expect(memory.get('register')).toBe('normal');
    expect(memory.get('citations')).toBe('on');
    memory.reset();
    expect(memory.facts()).toEqual([]);
    expect(memory.get('citations')).toBeNull();
  });

  it('starts turn numbering again after a full reset', () => {
    const memory = store();
    memory.record('register', 'terse');
    memory.record('register', 'normal');
    memory.reset();
    expect(memory.record('register', 'explanatory')?.turn).toBe(1);
  });

  it('normalises case and spacing so one value has one spelling', () => {
    const memory = store();
    expect(memory.record('register', '  Terse ')).not.toBeNull();
    expect(memory.get('register')).toBe('terse');
  });

  it('does not bump the counter on a refused value', () => {
    const memory = store();
    memory.record('tone', 'formal');
    const entry = memory.record('register', 'terse', { utterance: 'be brief' });
    expect(entry?.turn).toBe(1);
  });
});
