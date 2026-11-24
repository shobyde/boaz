// boaz bench — does the copy read like writing, or like a template?
//
// Probes grouped by `intent` are paraphrases of one question. The same facts
// must survive every phrasing (fidelity), while the words around them should
// change (similarity). Facts are masked before comparison: two answers sharing
// an email address are correct, not templated.
import fs from 'node:fs/promises';
import { loadProbes } from './probes.js';
import { ask, loadAgentModule, type AgentModule } from './harness.js';

interface BenchRow {
  intent: string;
  answers: string[];
  fidelity: number;
  similarity: number;
  openers: number;
  spread: number;
  ttr: number;
  stable: boolean;
  missing: string[];
}

const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const words = (text: string): string[] => norm(text).split(/[^a-z0-9@.+/-]+/).filter(Boolean);

function trigrams(text: string): Set<string> {
  const clean = norm(text).replace(/[^a-z0-9 ]/g, '');
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 2; i += 1) set.add(clean.slice(i, i + 3));
  return set;
}

function jaccard(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const gram of A) if (B.has(gram)) shared += 1;
  return shared / (A.size + B.size - shared);
}

const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

async function benchIntent(module: AgentModule, intent: string, questions: string[], must: string[]): Promise<BenchRow> {
  const answers: string[] = [];
  for (const question of questions) {
    answers.push((await ask(module.createEngine(), question, module.runCapability)).text);
  }
  const repeat = (await ask(module.createEngine(), questions[0] ?? '', module.runCapability)).text;

  const mask = (text: string): string =>
    must.reduce((out, needle) => out.split(needle).join('{fact}'), text);

  const sims: number[] = [];
  for (let i = 0; i < answers.length; i += 1) {
    for (let j = i + 1; j < answers.length; j += 1) sims.push(jaccard(mask(answers[i] ?? ''), mask(answers[j] ?? '')));
  }

  const hits = answers.filter((text) => must.every((needle) => norm(text).includes(norm(needle))));
  const lengths = answers.map((text) => words(text).length);
  const prefixes = answers.map((text) => words(text).slice(0, 3).join(' '));

  return {
    intent,
    answers,
    fidelity: answers.length ? hits.length / answers.length : 0,
    similarity: mean(sims),
    openers: new Set(prefixes).size / Math.max(answers.length, 1),
    spread: stdev(lengths),
    ttr: mean(answers.map((text) => new Set(words(text)).size / Math.max(words(text).length, 1))),
    stable: repeat === answers[0],
    missing: answers.filter((text) => !must.every((needle) => norm(text).includes(norm(needle)))),
  };
}

export async function runBench(options: {
  probes: string;
  module: string;
  json?: string;
  samples?: boolean;
}): Promise<number> {
  const probes = await loadProbes(options.probes);
  const groups = new Map<string, { questions: string[]; must: string[] }>();
  for (const probe of probes) {
    const intent = probe.intent ?? probe.expect;
    if (!intent) {
      process.stderr.write(`bench: "${probe.question}" needs an "intent" (or "expect") to group by\n`);
      return 2;
    }
    const group = groups.get(intent) ?? { questions: [], must: [] };
    group.questions.push(probe.question);
    if (probe.must?.length) group.must = probe.must;
    groups.set(intent, group);
  }

  // Intents without `must` are routes/actions: there is no copy to score, and a
  // similarity figure over tool-call JSON would be noise. They are listed, not
  // scored.
  const scored = [...groups].filter(([, group]) => group.must.length > 0);
  const unscored = [...groups].filter(([, group]) => group.must.length === 0).map(([intent]) => intent);
  if (scored.length === 0) {
    process.stderr.write('bench: no intents have a "must" list, so there is no copy to score\n');
    return 2;
  }

  const module = await loadAgentModule(options.module);
  const started = process.hrtime.bigint();
  const rows: BenchRow[] = [];
  for (const [intent, group] of scored) {
    rows.push(await benchIntent(module, intent, group.questions, group.must));
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  const all = rows.flatMap((row) => row.answers);
  const prefixes = all.map((text) => words(text).slice(0, 3).join(' '));
  const summary = {
    fidelity: mean(rows.map((row) => row.fidelity)),
    similarity: mean(rows.map((row) => row.similarity)),
    openers: new Set(prefixes).size / Math.max(all.length, 1),
    spread: stdev(all.map((text) => words(text).length)),
    ttr: mean(rows.map((row) => row.ttr)),
    stable: mean(rows.map((row) => (row.stable ? 1 : 0))),
    ms: elapsed,
    rows,
  };

  if (options.json) {
    await fs.writeFile(options.json, `${JSON.stringify(summary, null, 2)}\n`);
  }

  const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
  process.stdout.write('\nintent                fidelity  similarity  openers  spread  ttr   stable\n');
  for (const row of rows) {
    process.stdout.write(
      `${row.intent.padEnd(20)}  ${pct(row.fidelity).padStart(8)}  ${row.similarity.toFixed(2).padStart(10)}  ` +
        `${pct(row.openers).padStart(7)}  ${row.spread.toFixed(1).padStart(6)}  ${row.ttr.toFixed(2)}  ` +
        `${row.stable ? 'yes' : 'NO'}\n`,
    );
  }
  process.stdout.write(
    `${'—'.padEnd(20)}  ${pct(summary.fidelity).padStart(8)}  ${summary.similarity.toFixed(2).padStart(10)}  ` +
      `${pct(summary.openers).padStart(7)}  ${summary.spread.toFixed(1).padStart(6)}  ${summary.ttr.toFixed(2)}  ` +
      `${pct(summary.stable).padStart(5)}\n`,
  );
  process.stdout.write(
    (unscored.length ? `\nNot scored (no "must"): ${unscored.join(', ')}` : '') +
    `\n${rows.length} intents scored, ${all.length} answers, ${elapsed.toFixed(0)} ms. ` +
      'Similarity is measured with the required facts masked; lower means the phrasing changes.\n',
  );

  const failures = rows.filter((row) => row.fidelity < 1 || !row.stable);
  for (const row of failures) {
    if (row.fidelity < 1) {
      process.stdout.write(`\n${row.intent}: ${row.answers.length - row.fidelity * row.answers.length} answer(s) missing a required fact\n`);
      for (const text of row.missing) process.stdout.write(`  "${text.replace(/\s+/g, ' ').slice(0, 110)}"\n`);
    }
    if (!row.stable) process.stdout.write(`\n${row.intent}: same question answered differently twice\n`);
  }
  if (options.samples) {
    for (const row of rows) {
      process.stdout.write(`\n${row.intent}\n`);
      for (const answer of row.answers) process.stdout.write(`  "${answer.replace(/\s+/g, ' ')}"\n`);
    }
  }
  return failures.length === 0 ? 0 : 1;
}
