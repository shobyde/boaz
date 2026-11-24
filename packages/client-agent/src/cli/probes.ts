// Probe files: the questions an app promises its assistant can answer.
//
// A probe is one question plus what a correct answer looks like. The audit
// command checks *where* it goes; the bench command checks *how* it reads.
import fs from 'node:fs/promises';

export interface Probe {
  /** What the visitor types. */
  question: string;
  /**
   * The capability or answer rule that should handle it. Grouped intents share
   * one expectation ("projects.using").
   */
  expect?: string;
  /** Arguments the capability must be called with, when they are not inferable. */
  args?: Record<string, unknown>;
  /** Facts a correct answer must contain. Used by bench; audit ignores it. */
  must?: string[];
  /** Groups paraphrases of one question for the bench (e.g. "projects.using"). */
  intent?: string;
}

export interface ProbeFile {
  questions: Probe[];
}

export async function loadProbes(file: string): Promise<Probe[]> {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as ProbeFile | Probe[];
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${file}: expected { "questions": [...] } or a non-empty array`);
  }
  const probes = questions.map((probe, index) => {
    if (!probe || typeof probe.question !== 'string' || !probe.question.trim()) {
      throw new Error(`${file}: question ${index + 1} needs a "question" string`);
    }
    return {
      question: probe.question.trim(),
      ...(probe.expect ? { expect: probe.expect } : {}),
      ...(probe.args ? { args: probe.args } : {}),
      ...(probe.must ? { must: probe.must.map(String) } : {}),
      ...(probe.intent ? { intent: probe.intent } : {}),
    };
  });
  return probes;
}
